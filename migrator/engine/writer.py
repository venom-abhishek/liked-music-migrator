"""Applies destination modes A/B/C and dedups against existing YT state.

All actual YT Music writes happen here (and only here, besides undo). Every
attempted action is recorded to the ledger — including dry-run "would"
actions, which are prefixed so they never poison future duplicate checks.
"""
from __future__ import annotations

import logging
import random
import time

from schema import Song
from engine.matcher import MatchResult, AUTO
from engine.ledger import Ledger, DEST_LIKED, playlist_destination

logger = logging.getLogger(__name__)

WOULD_PREFIX = "would:"


def retry_backoff(fn, tries: int = 3, base_delay: float = 1.5, what: str = "call"):
    """Call fn() with retry-with-backoff. Re-raises the last exception."""
    last_exc = None
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last_exc = e
            if attempt < tries:
                delay = base_delay * (2 ** (attempt - 1))
                logger.warning("%s failed (attempt %d/%d): %s — retrying in %.1fs", what, attempt, tries, e, delay)
                time.sleep(delay)
    raise last_exc


class AuthError(Exception):
    """Raised when a write fails due to auth/permission — caller should stop gracefully."""


def _is_auth_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(t in msg for t in ("401", "403", "unauthoriz", "forbidden", "permission"))


class Writer:
    def __init__(self, yt, ledger: Ledger, run_id: str, dry_run: bool, config: dict):
        self.yt = yt
        self.ledger = ledger
        self.run_id = run_id
        self.dry_run = dry_run
        self.delay_range = (
            config.get("delay_min_sec", 1.0),
            config.get("delay_max_sec", 2.5),
        )
        self.retry_tries = config.get("retry_attempts", 3)

        self.liked_video_ids: set[str] = set()
        self.liked_keys: set[str] = set()
        self.playlists_by_name: dict[str, str] = {}
        self._playlist_items_cache: dict[str, tuple[set[str], set[str]]] = {}
        # placeholder ids for playlists that don't exist yet (dry-run or not-yet-created)
        self._pending_playlist_ids: dict[str, str] = {}
        self.counts: dict[str, int] = {}

    # ---- preload existing YT state ----------------------------------
    def preload(self) -> None:
        liked = retry_backoff(lambda: self.yt.get_liked_songs(limit=100000), what="get_liked_songs")
        for t in liked.get("tracks", []):
            vid = t.get("videoId")
            if vid:
                self.liked_video_ids.add(vid)
            self.liked_keys.add(_track_key(t))

        playlists = retry_backoff(lambda: self.yt.get_library_playlists(limit=100000), what="get_library_playlists")
        for p in playlists:
            name = p.get("title", "")
            pid = p.get("playlistId")
            if name and pid:
                self.playlists_by_name[name] = pid

    def _load_playlist_items(self, playlist_id: str) -> tuple[set[str], set[str]]:
        if playlist_id in self._playlist_items_cache:
            return self._playlist_items_cache[playlist_id]
        if playlist_id.startswith("NEW:"):
            result = (set(), set())
        else:
            data = retry_backoff(
                lambda: self.yt.get_playlist(playlist_id, limit=100000), what="get_playlist"
            )
            vids = set()
            keys = set()
            for t in data.get("tracks", []):
                vid = t.get("videoId")
                if vid:
                    vids.add(vid)
                keys.add(_track_key(t))
            result = (vids, keys)
        self._playlist_items_cache[playlist_id] = result
        return result

    def get_or_create_playlist(self, name: str) -> str:
        """Reuse-and-append if a playlist of this name already exists;
        otherwise create it (or a placeholder id, if dry-run)."""
        if name in self.playlists_by_name:
            return self.playlists_by_name[name]
        if name in self._pending_playlist_ids:
            return self._pending_playlist_ids[name]

        if self.dry_run:
            placeholder = f"NEW:{name}"
            self._pending_playlist_ids[name] = placeholder
            return placeholder

        pid = retry_backoff(
            lambda: self.yt.create_playlist(name, f"Migrated by liked-music-migrator (run {self.run_id})"),
            what="create_playlist",
        )
        if isinstance(pid, dict):
            pid = pid.get("id") or pid.get("playlistId")
        self.playlists_by_name[name] = pid
        self._pending_playlist_ids.pop(name, None)
        self.ledger.record_playlist_created(name, pid, self.run_id)
        time.sleep(random.uniform(*self.delay_range))
        return pid

    # ---- per-song write -----------------------------------------------
    def write_song(self, song: Song, match: MatchResult, destination_kind: str, playlist_name: str = "") -> str:
        """destination_kind: 'liked' or 'playlist'. Returns final decision string."""
        self.bump("seen")

        if match.decision != AUTO:
            self.ledger.append(
                {
                    "source": song.source,
                    "collection_type": song.collection_type,
                    "collection_name": song.collection_name,
                    "title": song.title,
                    "artists": song.artists,
                    "decision": match.decision,
                    "destination": "",
                    "yt_videoId": "",
                    "yt_playlistId": "",
                    "combined_score": "",
                    "run_id": self.run_id,
                }
            )
            self.bump(match.decision)
            return match.decision

        video_id = match.chosen.videoId
        key = song.key()

        if destination_kind == "liked":
            real_dest = DEST_LIKED
            already = video_id in self.liked_video_ids or key in self.liked_keys
            playlist_id = ""
        else:
            playlist_id = self.get_or_create_playlist(playlist_name)
            real_dest = playlist_destination(playlist_name)
            item_ids, item_keys = self._load_playlist_items(playlist_id)
            already = video_id in item_ids or key in item_keys

        if already:
            decision = "already_present"
        elif self.ledger.is_duplicate(key, real_dest):
            decision = "duplicate"
        else:
            decision = AUTO

        label = (WOULD_PREFIX + real_dest) if self.dry_run else real_dest

        if decision == AUTO and not self.dry_run:
            try:
                if destination_kind == "liked":
                    retry_backoff(
                        lambda: self.yt.rate_song(video_id, "LIKE"),
                        tries=self.retry_tries,
                        what=f"rate_song({song.title})",
                    )
                    self.liked_video_ids.add(video_id)
                    self.liked_keys.add(key)
                else:
                    retry_backoff(
                        lambda: self.yt.add_playlist_items(playlist_id, [video_id]),
                        tries=self.retry_tries,
                        what=f"add_playlist_items({song.title})",
                    )
                    ids, keys = self._playlist_items_cache.get(playlist_id, (set(), set()))
                    ids.add(video_id)
                    keys.add(key)
                    self._playlist_items_cache[playlist_id] = (ids, keys)
                time.sleep(random.uniform(*self.delay_range))
            except Exception as e:  # noqa: BLE001
                if _is_auth_error(e):
                    raise AuthError(str(e)) from e
                logger.error("write failed for %s: %s", song.title, e)
                decision = "error"

        # normalize the placeholder playlist id into the ledger only once real
        ledger_playlist_id = playlist_id
        if ledger_playlist_id.startswith("NEW:"):
            ledger_playlist_id = ""

        self.ledger.append(
            {
                "source": song.source,
                "collection_type": song.collection_type,
                "collection_name": song.collection_name,
                "title": song.title,
                "artists": song.artists,
                "decision": decision,
                "destination": label if decision in (AUTO,) else real_dest,
                "yt_videoId": video_id,
                "yt_playlistId": ledger_playlist_id,
                "combined_score": f"{match.chosen.combined:.1f}",
                "run_id": self.run_id,
            }
        )
        self.bump(decision)
        return decision

    def bump(self, key: str) -> None:
        self.counts[key] = self.counts.get(key, 0) + 1


def _track_key(track: dict) -> str:
    from schema import normalize_title, normalize_artist

    title = normalize_title(track.get("title", ""))
    artists = track.get("artists") or []
    artist_str = normalize_artist(", ".join(a.get("name", "") for a in artists if a.get("name")))
    return f"{title}|{artist_str}"
