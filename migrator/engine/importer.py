"""Orchestrates load -> match -> write. Owns dry-run/commit and resumability."""
from __future__ import annotations

import csv
import logging
import sys
from pathlib import Path

from schema import Song, load_songs
from engine import matcher as matcher_mod
from engine.matcher import MatchResult, Candidate, AUTO, REVIEW, NOT_FOUND
from engine.ledger import Ledger, new_run_id, DEST_LIKED, playlist_destination
from engine.writer import Writer, AuthError, retry_backoff

logger = logging.getLogger(__name__)


def _preload_or_exit(writer) -> None:
    """writer.preload() fetches your entire existing Liked Songs + playlists
    for dedup — a big paginated call that occasionally hits a transient
    network blip. Give a clean message and exit instead of a raw traceback;
    nothing has been written yet at this point, so it's always safe to just
    retry the same command."""
    try:
        writer.preload()
    except Exception as e:  # noqa: BLE001
        print("\n" + "=" * 60)
        print("Failed to load your existing YT Music library (needed for dedup).")
        print(f"  {e}")
        print("  This is usually a transient network hiccup — no writes have")
        print("  happened yet, so it's safe to just re-run the same command.")
        print("=" * 60)
        sys.exit(1)


REVIEW_FIELDS = [
    "source", "collection_type", "collection_name", "title", "artists", "album",
    "duration_sec", "target_destination", "candidate_videoId", "candidate_title",
    "candidate_artists", "combined_score", "artist_score", "duration_score",
]
NOT_FOUND_FIELDS = [
    "source", "collection_type", "collection_name", "title", "artists", "album",
    "duration_sec", "version_tag", "reason", "top_candidate_title",
    "top_candidate_artists", "top_candidate_videoId", "top_candidate_score",
]


def _destination_for(song: Song, mode: str, playlist_name: str) -> tuple[str, str, str]:
    """Returns (destination_kind, playlist_name_or_empty, destination_label)."""
    if mode == "A":
        return "liked", "", DEST_LIKED
    if mode == "B":
        return "playlist", playlist_name, playlist_destination(playlist_name)
    if mode == "C":
        if song.collection_type == "liked":
            return "liked", "", DEST_LIKED
        return "playlist", song.collection_name, playlist_destination(song.collection_name)
    raise ValueError(f"Unknown mode: {mode}")


def run_import(
    csv_path: str,
    mode: str,
    yt,
    config: dict,
    playlist_name: str = "",
    commit: bool = False,
    data_dir: str = "data",
) -> dict:
    if mode == "B" and not playlist_name:
        raise ValueError("Mode B requires --playlist-name")

    songs = load_songs(csv_path)
    if not songs:
        raise ValueError(f"No songs loaded from {csv_path}")

    data_dir = Path(data_dir)
    ledger = Ledger(data_dir / "ledger.csv")
    run_id = new_run_id()
    dry_run = not commit
    writer = Writer(yt, ledger, run_id, dry_run, config.get("importer", {}))
    _preload_or_exit(writer)

    review_rows = []
    not_found_rows = []
    seen_per_destination: dict[str, set[str]] = {}

    matching_cfg = config.get("matching", {})

    for song in songs:
        dest_kind, plist_name, dest_label = _destination_for(song, mode, playlist_name)

        # Resumed runs: a prior run's successful AUTO write for this exact
        # (song, destination) means we already know the outcome — skip the
        # search entirely rather than re-querying YT Music for nothing.
        if ledger.is_duplicate(song.key(), dest_label):
            ledger.append({
                "source": song.source, "collection_type": song.collection_type,
                "collection_name": song.collection_name, "title": song.title,
                "artists": song.artists, "decision": "duplicate", "destination": dest_label,
                "yt_videoId": "", "yt_playlistId": "", "combined_score": "", "run_id": run_id,
            })
            writer.bump("duplicate")
            continue

        try:
            match = retry_backoff(
                lambda: matcher_mod.match_song(song, yt, matching_cfg),
                tries=writer.retry_tries,
                what=f"search({song.title})",
            )
        except Exception as e:  # noqa: BLE001
            logger.error("search failed for %s, marking error: %s", song.title, e)
            ledger.append({
                "source": song.source, "collection_type": song.collection_type,
                "collection_name": song.collection_name, "title": song.title,
                "artists": song.artists, "decision": "error", "destination": "",
                "yt_videoId": "", "yt_playlistId": "", "combined_score": "", "run_id": run_id,
            })
            writer.bump("error")
            continue

        if match.decision == AUTO:
            seen = seen_per_destination.setdefault(dest_label, set())
            video_id = match.chosen.videoId
            if video_id in seen:
                ledger.append({
                    "source": song.source, "collection_type": song.collection_type,
                    "collection_name": song.collection_name, "title": song.title,
                    "artists": song.artists, "decision": "duplicate", "destination": dest_label,
                    "yt_videoId": video_id, "yt_playlistId": "", "combined_score": f"{match.chosen.combined:.1f}",
                    "run_id": run_id,
                })
                writer.bump("duplicate")
                continue
            seen.add(video_id)

        try:
            decision = writer.write_song(song, match, dest_kind, plist_name)
        except AuthError as e:
            print("\n" + "=" * 60)
            print("AUTH/PERMISSION ERROR — stopping run.")
            print(f"  {e}")
            print("  Ledger has been flushed. Re-authenticate (python run.py setup-ytm)")
            print(f"  then re-run; run_id={run_id} rows already written are preserved.")
            print("=" * 60)
            break

        if match.decision == REVIEW:
            c = match.chosen
            review_rows.append({
                "source": song.source, "collection_type": song.collection_type,
                "collection_name": song.collection_name, "title": song.title,
                "artists": song.artists, "album": song.album,
                "duration_sec": song.duration_sec if song.duration_sec is not None else "",
                "target_destination": dest_label,
                "candidate_videoId": c.videoId if c else "",
                "candidate_title": c.title if c else "",
                "candidate_artists": c.artists if c else "",
                "combined_score": f"{c.combined:.1f}" if c else "",
                "artist_score": f"{c.artist_score:.1f}" if c else "",
                "duration_score": f"{c.duration_score:.1f}" if c else "",
            })
        elif match.decision == NOT_FOUND:
            c = match.chosen
            not_found_rows.append({
                "source": song.source, "collection_type": song.collection_type,
                "collection_name": song.collection_name, "title": song.title,
                "artists": song.artists, "album": song.album,
                "duration_sec": song.duration_sec if song.duration_sec is not None else "",
                "version_tag": match.version_tag,
                "reason": match.reason,
                "top_candidate_title": c.title if c else "",
                "top_candidate_artists": c.artists if c else "",
                "top_candidate_videoId": c.videoId if c else "",
                "top_candidate_score": f"{c.combined:.1f}" if c else "",
            })

    _write_csv(data_dir / "review.csv", REVIEW_FIELDS, review_rows)
    _write_csv(data_dir / "not_found.csv", NOT_FOUND_FIELDS, not_found_rows)

    summary = writer.counts
    _print_summary(summary, dry_run, run_id, data_dir)
    return {"run_id": run_id, "dry_run": dry_run, "counts": summary}


def run_approved(review_csv_path: str, yt, config: dict, commit: bool = False, data_dir: str = "data") -> dict:
    """Re-process rows remaining in review.csv (after operator pruned rejects).
    Uses the candidate videoId already recorded — no re-search."""
    data_dir = Path(data_dir)
    ledger = Ledger(data_dir / "ledger.csv")
    run_id = new_run_id()
    dry_run = not commit
    writer = Writer(yt, ledger, run_id, dry_run, config.get("importer", {}))
    _preload_or_exit(writer)

    with open(review_csv_path, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    seen_per_destination: dict[str, set[str]] = {}

    for row in rows:
        song = Song(
            source=row.get("source", ""),
            collection_type=row.get("collection_type", ""),
            collection_name=row.get("collection_name", ""),
            title=row.get("title", ""),
            artists=row.get("artists", ""),
            album=row.get("album", ""),
            duration_sec=int(row["duration_sec"]) if row.get("duration_sec") else None,
        )
        dest_label = row.get("target_destination", "")
        if dest_label == DEST_LIKED:
            dest_kind, plist_name = "liked", ""
        elif dest_label.startswith("playlist:"):
            dest_kind, plist_name = "playlist", dest_label.split(":", 1)[1]
        else:
            logger.warning("Skipping row with unknown target_destination: %r", dest_label)
            continue

        video_id = row.get("candidate_videoId", "")
        if not video_id:
            continue

        seen = seen_per_destination.setdefault(dest_label, set())
        if video_id in seen:
            continue
        seen.add(video_id)

        candidate = Candidate(
            videoId=video_id,
            title=row.get("candidate_title", ""),
            artists=row.get("candidate_artists", ""),
            album="",
            duration_seconds=None,
            resultType="song",
            combined=float(row.get("combined_score") or 0),
        )
        match = MatchResult(decision=AUTO, chosen=candidate, reason="approved")

        try:
            writer.write_song(song, match, dest_kind, plist_name)
        except AuthError as e:
            print("\nAUTH/PERMISSION ERROR — stopping approved-import run.")
            print(f"  {e}")
            break

    summary = writer.counts
    _print_summary(summary, dry_run, run_id, data_dir)
    return {"run_id": run_id, "dry_run": dry_run, "counts": summary}


def _write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def _print_summary(counts: dict, dry_run: bool, run_id: str, data_dir: Path) -> None:
    print("\n" + "=" * 60)
    print(f"{'DRY RUN' if dry_run else 'COMMIT'} summary — run_id={run_id}")
    print("-" * 60)
    for label in (AUTO, REVIEW, NOT_FOUND, "already_present", "duplicate", "error"):
        if label in counts:
            print(f"  {label:<18} {counts[label]}")
    print("-" * 60)
    print(f"  ledger:     {data_dir / 'ledger.csv'}")
    print(f"  review:     {data_dir / 'review.csv'}")
    print(f"  not_found:  {data_dir / 'not_found.csv'}")
    if dry_run:
        print("\n  Zero YT Music writes were made. Re-run with --commit to apply.")
    print("=" * 60)
