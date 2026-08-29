"""Phase 1 — JioSaavn extractor.

Discovery (BUILD_SPEC §12, done live against the operator's account) found
that JioSaavn's internal API returns BOTH liked songs and every playlist's
full track-ID list as complete, unpaginated JSON in a single call each —
no DOM scrolling or virtualization to fight. So this implements §6 Tier 2
("direct paginated calls — the target end state") directly; Tier 3 DOM
scraping isn't needed for this source and isn't implemented.

Endpoints (undocumented, unofficial — found via DevTools, may change):
  - Liked songs:  GET /api.php?__call=library.getAll&...
                  -> {"song": [id, id, ...], "album": [...], "show": [...], ...}
                  Podcast/show items live in a separate "show" key entirely,
                  so reading only "song" already excludes them.
  - Playlists:    GET /api.php?__call=playlist.list&all_playlists=true&contents=1&onlypids=true&...
                  -> [{"id", "title", "subtitle": "N Songs",
                       "more_info": {"contents": "id1,id2,..."}}, ...]
                  Every playlist's full track-id list comes back inline.
  - Hydration:    GET /api.php?__call=library.getDetails&entity_type=song&entity_ids=<up to ~50 ids>&...
                  -> {"songs": [{"id","title","type",
                       "more_info": {"album","duration",
                         "artistMap": {"primary_artists":[{"name"}], "featured_artists":[...]}}}]}
                  Called in batches of HYDRATE_BATCH_SIZE ids (not true
                  offset/cursor pagination — just id-batching).
"""
from __future__ import annotations

import html
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

from schema import Song, save_songs, detect_version_tag

PROFILE_DIR = "data/jiosaavn_profile"
BASE_URL = "https://www.jiosaavn.com"
API_URL = f"{BASE_URL}/api.php"
LIKED_SONGS_PAGE = f"{BASE_URL}/my-music/songs"
OUTPUT_CSV = "data/jiosaavn.csv"
HYDRATE_BATCH_SIZE = 50

# Small real-world drift (a handful of unavailable/region-locked tracks not
# reflected in the UI's cached count badge) is expected and shouldn't block
# an entire migration. A gap bigger than this suggests an actual capture bug
# (e.g. the API changed shape) and should fail loudly instead.
COUNT_DRIFT_TOLERANCE = 5

_COUNT_BADGE_RE = re.compile(r"^\s*(\d+)\s+songs?\s*$", re.IGNORECASE)
_SUBTITLE_COUNT_RE = re.compile(r"(\d+)\s+songs?", re.IGNORECASE)


class CountMismatchError(Exception):
    """Raised when captured count is unexpectedly far from the stated total."""


def _api_params(**extra) -> dict:
    params = {"api_version": "4", "_format": "json", "_marker": "0", "ctx": "web6dot0"}
    params.update(extra)
    return params


def _get_json(request, **extra) -> dict | list:
    resp = request.get(API_URL, params=_api_params(**extra))
    if not resp.ok:
        raise RuntimeError(f"JioSaavn API call failed ({resp.status}): __call={extra.get('__call')}")
    return resp.json()


def _launch():
    pw = sync_playwright().start()
    # channel="chrome" drives the operator's actual installed Chrome rather
    # than Playwright's bundled Chromium build — the login CAPTCHA's bot-risk
    # scoring was rejecting the bundled build outright (see BUILD_SPEC §12
    # discovery notes). Falls back to bundled Chromium if real Chrome isn't
    # installed.
    try:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR, headless=False, channel="chrome"
        )
    except Exception:
        context = pw.chromium.launch_persistent_context(user_data_dir=PROFILE_DIR, headless=False)
    page = context.pages[0] if context.pages else context.new_page()
    return pw, context, page


def _stated_liked_count(page) -> int | None:
    for text in page.locator("p, span, div").all_text_contents():
        m = _COUNT_BADGE_RE.match(text.strip())
        if m:
            return int(m.group(1))
    return None


def _ensure_logged_in(page) -> None:
    page.goto(LIKED_SONGS_PAGE)
    page.wait_for_timeout(1500)
    if _stated_liked_count(page) is None:
        print("Please log in to JioSaavn in the opened browser window.")
        input("Press Enter once you're logged in and on your Liked Songs page... ")
        page.goto(LIKED_SONGS_PAGE)
        page.wait_for_timeout(1500)


def _check_count(label: str, captured: int, stated: int | None) -> None:
    if stated is None:
        print(f"  [warn] {label}: couldn't read a stated total to verify against; captured {captured}.")
        return
    gap = stated - captured
    if gap == 0:
        return
    if abs(gap) > COUNT_DRIFT_TOLERANCE:
        raise CountMismatchError(
            f"{label}: expected {stated}, captured {captured} — {abs(gap)} "
            f"{'missing' if gap > 0 else 'extra'} (exceeds drift tolerance of "
            f"{COUNT_DRIFT_TOLERANCE}, likely a real capture bug)"
        )
    print(
        f"  [warn] {label}: expected {stated}, captured {captured} — {abs(gap)} "
        f"{'missing' if gap > 0 else 'extra'} (within tolerance; likely unavailable/"
        f"region-locked tracks not reflected in the cached UI count)"
    )


def _hydrate(request, ids: list[str]) -> list[dict]:
    songs = []
    for i in range(0, len(ids), HYDRATE_BATCH_SIZE):
        batch = ids[i : i + HYDRATE_BATCH_SIZE]
        data = _get_json(
            request,
            __call="library.getDetails",
            entity_ids=",".join(batch),
            entity_type="song",
            n=str(HYDRATE_BATCH_SIZE),
        )
        songs.extend(data.get("songs", []))
    return songs


def _to_song(raw: dict, source: str, collection_type: str, collection_name: str) -> Song | None:
    if raw.get("type") != "song":
        return None
    more = raw.get("more_info", {}) or {}
    artist_map = more.get("artistMap", {}) or {}
    names = [a["name"] for a in artist_map.get("primary_artists", []) if a.get("name")]
    names += [a["name"] for a in artist_map.get("featured_artists", []) if a.get("name")]
    # JioSaavn's API returns HTML-entity-escaped text (e.g. "&quot;") in
    # title/artist/album fields — unescape it, or it corrupts YT Music search.
    artists = html.unescape(", ".join(dict.fromkeys(names)))
    title = html.unescape(raw.get("title", ""))
    duration = more.get("duration")
    return Song(
        source=source,
        collection_type=collection_type,
        collection_name=collection_name,
        source_id=raw.get("id", ""),
        title=title,
        artists=artists,
        album=html.unescape(more.get("album", "")),
        duration_sec=int(duration) if duration else None,
        version_tag=detect_version_tag(title),
    )


def inventory() -> dict:
    pw, context, page = _launch()
    try:
        _ensure_logged_in(page)
        request = context.request

        liked_all = _get_json(request, __call="library.getAll")
        liked_ids = list(dict.fromkeys((liked_all or {}).get("song", [])))
        stated_liked = _stated_liked_count(page)

        playlists_raw = _get_json(
            request, __call="playlist.list", all_playlists="true", contents="1", onlypids="true"
        )
        playlists = []
        for p in playlists_raw or []:
            contents = [c for c in (p.get("more_info", {}) or {}).get("contents", "").split(",") if c]
            playlists.append(
                {
                    "id": p.get("id", ""),
                    "name": p.get("title", ""),
                    "count": len(list(dict.fromkeys(contents))),
                    "_content_ids": list(dict.fromkeys(contents)),
                }
            )

        return {
            "liked": {"count": len(liked_ids), "stated_count": stated_liked, "_ids": liked_ids},
            "playlists": playlists,
        }
    finally:
        context.close()
        pw.stop()


def _prompt_selection(data: dict) -> dict:
    print(f"\nLiked Songs: {data['liked']['count']} songs")
    print("Playlists:")
    for i, p in enumerate(data["playlists"], 1):
        print(f"  {i}. {p['name']} ({p['count']} tracks)")

    include_liked = input("\nInclude Liked Songs? [Y/n]: ").strip().lower() != "n"
    raw = input(
        "Which playlists to include? (comma-separated numbers, 'all', or blank for none): "
    ).strip()
    if raw.lower() == "all":
        chosen_playlists = data["playlists"]
    elif raw:
        idxs = {int(x.strip()) for x in raw.split(",") if x.strip().isdigit()}
        chosen_playlists = [p for i, p in enumerate(data["playlists"], 1) if i in idxs]
    else:
        chosen_playlists = []

    return {"liked": include_liked, "playlists": chosen_playlists}


def extract(selection: dict | None = None) -> str:
    pw, context, page = _launch()
    try:
        _ensure_logged_in(page)
        request = context.request
        data = inventory_data = None

        if selection is None:
            inventory_data = _live_inventory(request, page)
            selection = _prompt_selection(inventory_data)

        songs: list[Song] = []

        if selection.get("liked"):
            if inventory_data is None:
                inventory_data = _live_inventory(request, page)
            ids = inventory_data["liked"]["_ids"]
            hydrated = _hydrate(request, ids)
            _check_count("Liked Songs", len(hydrated), inventory_data["liked"]["stated_count"])
            for raw in hydrated:
                s = _to_song(raw, "jiosaavn", "liked", "Liked Songs")
                if s:
                    songs.append(s)
            print(f"Liked Songs: {len(songs)} tracks extracted")

        for p in selection.get("playlists", []):
            ids = p.get("_content_ids")
            if ids is None:
                # selection came from CLI flags, not live inventory — refetch
                if inventory_data is None:
                    inventory_data = _live_inventory(request, page)
                match = next((x for x in inventory_data["playlists"] if x["name"] == p.get("name")), None)
                ids = match["_content_ids"] if match else []
            hydrated = _hydrate(request, ids)
            _check_count(f"Playlist '{p['name']}'", len(hydrated), p.get("count"))
            count_before = len(songs)
            for raw in hydrated:
                s = _to_song(raw, "jiosaavn", "playlist", p["name"])
                if s:
                    songs.append(s)
            print(f"Playlist '{p['name']}': {len(songs) - count_before} tracks extracted")

        save_songs(songs, OUTPUT_CSV)
        print(f"\nSaved {len(songs)} total tracks to {OUTPUT_CSV}")
        print("\nPreview:")
        for s in songs[:5]:
            print(f"  {s.collection_name}: {s.title} — {s.artists}")

        return OUTPUT_CSV
    finally:
        context.close()
        pw.stop()


def _live_inventory(request, page) -> dict:
    liked_all = _get_json(request, __call="library.getAll")
    liked_ids = list(dict.fromkeys((liked_all or {}).get("song", [])))
    stated_liked = _stated_liked_count(page)

    playlists_raw = _get_json(
        request, __call="playlist.list", all_playlists="true", contents="1", onlypids="true"
    )
    playlists = []
    for p in playlists_raw or []:
        contents = [c for c in (p.get("more_info", {}) or {}).get("contents", "").split(",") if c]
        playlists.append(
            {
                "id": p.get("id", ""),
                "name": p.get("title", ""),
                "count": len(list(dict.fromkeys(contents))),
                "_content_ids": list(dict.fromkeys(contents)),
            }
        )
    return {
        "liked": {"count": len(liked_ids), "stated_count": stated_liked, "_ids": liked_ids},
        "playlists": playlists,
    }
