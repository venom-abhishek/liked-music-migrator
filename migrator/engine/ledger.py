"""Master ledger: idempotency record + undo.

One row per processed track (plus special "playlist_created" marker rows
used only for undo bookkeeping). Writes are appended immediately so a run
is resumable/inspectable even if it's interrupted.
"""
from __future__ import annotations

import csv
import logging
import random
import string
import time
from datetime import datetime, timezone
from pathlib import Path

from schema import normalize_title, normalize_artist

logger = logging.getLogger(__name__)

FIELDNAMES = [
    "source",
    "collection_type",
    "collection_name",
    "title",
    "artists",
    "decision",
    "destination",
    "yt_videoId",
    "yt_playlistId",
    "combined_score",
    "run_id",
    "timestamp",
]

DEST_LIKED = "liked"


def playlist_destination(name: str) -> str:
    return f"playlist:{name}"


def new_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"{stamp}_{suffix}"


class Ledger:
    def __init__(self, path: str | Path = "data/ledger.csv"):
        self.path = Path(path)
        self.rows: list[dict] = []
        if self.path.exists():
            with self.path.open("r", encoding="utf-8", newline="") as f:
                self.rows = list(csv.DictReader(f))
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w", encoding="utf-8", newline="") as f:
                csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()

    def append(self, row: dict) -> None:
        full = {k: row.get(k, "") for k in FIELDNAMES}
        full.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        self.rows.append(full)
        with self.path.open("a", encoding="utf-8", newline="") as f:
            csv.DictWriter(f, fieldnames=FIELDNAMES).writerow(full)

    def record_playlist_created(self, name: str, playlist_id: str, run_id: str) -> None:
        self.append(
            {
                "source": "",
                "collection_type": "",
                "collection_name": "",
                "title": "",
                "artists": "",
                "decision": "playlist_created",
                "destination": playlist_destination(name),
                "yt_videoId": "",
                "yt_playlistId": playlist_id,
                "combined_score": "",
                "run_id": run_id,
            }
        )

    def is_duplicate(self, key: str, destination: str) -> bool:
        """True if a prior AUTO write already put this key in this destination.

        `key` is expected to already be Song.key() (normalized). Ledger rows
        store raw title/artists, so they're normalized here too — comparing
        raw against normalized would essentially never match.
        """
        for row in self.rows:
            if row.get("decision") != "AUTO":
                continue
            if row.get("destination") != destination:
                continue
            row_key = f"{normalize_title(row.get('title', ''))}|{normalize_artist(row.get('artists', ''))}"
            if row_key == key:
                return True
        return False

    def created_playlist_ids(self, run_id: str | None = None) -> set[str]:
        ids = set()
        for row in self.rows:
            if row.get("decision") != "playlist_created":
                continue
            if run_id is not None and row.get("run_id") != run_id:
                continue
            pid = row.get("yt_playlistId")
            if pid:
                ids.add(pid)
        return ids

    def rows_for_run(self, run_id: str) -> list[dict]:
        return [r for r in self.rows if r.get("run_id") == run_id]

    def summary_for_run(self, run_id: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in self.rows_for_run(run_id):
            d = row.get("decision", "")
            if d == "playlist_created":
                continue
            counts[d] = counts.get(d, 0) + 1
        return counts


def undo(run_id: str, yt, ledger: Ledger, delay_range: tuple[float, float] = (1.0, 2.5)) -> dict:
    """Reverse exactly `run_id`: un-like liked tracks, remove added playlist
    items, delete playlists created in that run. This is the only place
    removal/deletion is allowed.
    """
    run_rows = ledger.rows_for_run(run_id)
    if not run_rows:
        raise ValueError(f"No ledger rows found for run_id={run_id}")

    created_ids = ledger.created_playlist_ids(run_id)
    unliked = 0
    removed = 0
    deleted_playlists = 0
    errors = []

    for row in run_rows:
        if row.get("decision") != "AUTO":
            continue
        dest = row.get("destination", "")
        video_id = row.get("yt_videoId", "")
        if not video_id:
            continue
        try:
            if dest == DEST_LIKED:
                yt.rate_song(video_id, "INDIFFERENT")
                unliked += 1
                time.sleep(random.uniform(*delay_range))
            elif dest.startswith("playlist:"):
                pid = row.get("yt_playlistId", "")
                if pid and pid not in created_ids:
                    yt.remove_playlist_items(pid, [{"videoId": video_id}])
                    removed += 1
                    time.sleep(random.uniform(*delay_range))
                # if pid is in created_ids, the whole playlist gets deleted below
        except Exception as e:  # noqa: BLE001
            logger.warning("undo: failed to reverse %s (%s): %s", row.get("title"), dest, e)
            errors.append({"title": row.get("title"), "destination": dest, "error": str(e)})

    for pid in created_ids:
        try:
            yt.delete_playlist(pid)
            deleted_playlists += 1
            time.sleep(random.uniform(*delay_range))
        except Exception as e:  # noqa: BLE001
            logger.warning("undo: failed to delete playlist %s: %s", pid, e)
            errors.append({"playlist_id": pid, "error": str(e)})

    return {
        "run_id": run_id,
        "unliked": unliked,
        "removed_playlist_items": removed,
        "deleted_playlists": deleted_playlists,
        "errors": errors,
    }
