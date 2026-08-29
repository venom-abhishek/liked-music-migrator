"""Song dataclass + CSV IO + normalization helpers.

This is the contract between every extractor and the engine. All extractors
write one CSV per source (all selected collections in one file); the engine
reads only this schema and never anything source-specific.
"""
from __future__ import annotations

import csv
import re
import unicodedata
from dataclasses import dataclass, fields, asdict
from pathlib import Path

FIELDNAMES = [
    "source",
    "collection_type",
    "collection_name",
    "source_id",
    "title",
    "artists",
    "album",
    "duration_sec",
    "isrc",
    "version_tag",
]

VERSION_TAG_PATTERNS = [
    ("remix", r"\bremix(?:es)?\b"),
    ("live", r"\blive\b"),
    ("acoustic", r"\bacoustic\b"),
    ("cover", r"\bcover\b"),
    ("sped_up", r"\bsped[\s-]?up\b"),
    ("instrumental", r"\binstrumental\b"),
    ("explicit", r"\bexplicit\b"),
    ("remaster", r"\bremaster(?:ed)?\b"),
]

# Bracketed/parenthesized qualifiers to strip during normalization, e.g.
# "[Explicit]", "(Remastered 2011)", "(Bonus Track)".
_BRACKET_RE = re.compile(r"[\[\(][^\]\)]*[\]\)]")
_FEAT_RE = re.compile(r"\b(feat\.?|ft\.?|featuring)\b.*$", re.IGNORECASE)
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


@dataclass
class Song:
    source: str
    collection_type: str  # "liked" or "playlist"
    collection_name: str
    title: str
    artists: str
    source_id: str = ""
    album: str = ""
    duration_sec: int | None = None
    isrc: str = ""
    version_tag: str = ""

    def key(self) -> str:
        """Normalized identity used for dedup/comparison."""
        return f"{normalize_title(self.title)}|{normalize_artist(self.artists)}"


def _parse_duration(raw: str) -> int | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    if ":" in raw:
        parts = raw.split(":")
        try:
            parts = [int(p) for p in parts]
        except ValueError:
            return None
        secs = 0
        for p in parts:
            secs = secs * 60 + p
        return secs
    try:
        return int(float(raw))
    except ValueError:
        return None


def load_songs(path: str | Path) -> list[Song]:
    path = Path(path)
    songs: list[Song] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            duration_raw = row.get("duration_sec", "")
            duration = _parse_duration(duration_raw) if duration_raw else None
            songs.append(
                Song(
                    source=row.get("source", "").strip(),
                    collection_type=row.get("collection_type", "").strip(),
                    collection_name=row.get("collection_name", "").strip(),
                    source_id=row.get("source_id", "").strip(),
                    title=row.get("title", "").strip(),
                    artists=row.get("artists", "").strip(),
                    album=row.get("album", "").strip(),
                    duration_sec=duration,
                    isrc=row.get("isrc", "").strip(),
                    version_tag=row.get("version_tag", "").strip(),
                )
            )
    return songs


def save_songs(songs: list[Song], path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for s in songs:
            row = asdict(s)
            row["duration_sec"] = "" if s.duration_sec is None else str(s.duration_sec)
            writer.writerow(row)


def normalize_title(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.lower()
    s = _BRACKET_RE.sub(" ", s)
    s = _FEAT_RE.sub("", s)
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def normalize_artist(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.lower()
    s = _BRACKET_RE.sub(" ", s)
    s = _FEAT_RE.sub("", s)
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def detect_version_tag(title: str) -> str:
    """Flags remix/live/acoustic/cover/sped-up/instrumental/explicit/remaster.

    Returns the first matching tag, or "" if none found. Used to route
    version-specific tracks to not_found.csv when no exact match exists.
    """
    if not title:
        return ""
    lowered = title.lower()
    for tag, pattern in VERSION_TAG_PATTERNS:
        if re.search(pattern, lowered):
            return tag
    return ""


def group_by_collection(songs: list[Song]) -> dict[tuple[str, str], list[Song]]:
    """Group songs by (collection_type, collection_name)."""
    groups: dict[tuple[str, str], list[Song]] = {}
    for s in songs:
        key = (s.collection_type, s.collection_name)
        groups.setdefault(key, []).append(s)
    return groups
