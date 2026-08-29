"""Deterministic search + scoring + bucket decision. No AI, no LLM calls.

Only "intelligence" here is rapidfuzz string similarity plus a fixed
weighted formula. Given a source Song, searches YT Music and buckets the
best candidate into AUTO / REVIEW / NOT_FOUND.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from rapidfuzz import fuzz

from schema import Song, normalize_artist, normalize_title, detect_version_tag

logger = logging.getLogger(__name__)

AUTO = "AUTO"
REVIEW = "REVIEW"
NOT_FOUND = "NOT_FOUND"

DEFAULT_CONFIG = {
    "auto_combined_threshold": 85,
    "auto_artist_threshold": 70,
    "review_combined_threshold": 70,
    "duration_exact_tolerance_sec": 3,
    "duration_max_tolerance_sec": 15,
    "duration_neutral_score": 70,
    "weight_title": 0.50,
    "weight_artist": 0.35,
    "weight_duration": 0.15,
    "song_result_bonus": 5,
    "search_limit": 5,
}


@dataclass
class Candidate:
    videoId: str
    title: str
    artists: str
    album: str
    duration_seconds: int | None
    resultType: str
    title_score: float = 0.0
    artist_score: float = 0.0
    duration_score: float = 0.0
    combined: float = 0.0


@dataclass
class MatchResult:
    decision: str
    chosen: Candidate | None = None
    runner_up: Candidate | None = None
    video_fallback: bool = False
    version_tag: str = ""
    reason: str = ""


def _duration_score(src_dur: int | None, cand_dur: int | None, cfg: dict) -> float:
    if src_dur is None or cand_dur is None:
        return cfg["duration_neutral_score"]
    diff = abs(src_dur - cand_dur)
    exact = cfg["duration_exact_tolerance_sec"]
    maxtol = cfg["duration_max_tolerance_sec"]
    if diff <= exact:
        return 100.0
    if diff >= maxtol:
        return 0.0
    # linear decay from 100 at `exact` to 0 at `maxtol`
    span = maxtol - exact
    return 100.0 * (1 - (diff - exact) / span)


def _extract_candidates(raw_results: list[dict], allow_video: bool) -> list[Candidate]:
    out = []
    for r in raw_results:
        result_type = r.get("resultType", "")
        if result_type not in ("song", "video"):
            continue
        if result_type == "video" and not allow_video:
            continue
        video_id = r.get("videoId")
        if not video_id:
            continue
        artists = r.get("artists") or []
        artist_names = ", ".join(a.get("name", "") for a in artists if a.get("name"))
        album = r.get("album") or {}
        album_name = album.get("name", "") if isinstance(album, dict) else ""
        out.append(
            Candidate(
                videoId=video_id,
                title=r.get("title", ""),
                artists=artist_names,
                album=album_name,
                duration_seconds=r.get("duration_seconds"),
                resultType=result_type,
            )
        )
    return out


def _score_candidates(song: Song, candidates: list[Candidate], cfg: dict) -> list[Candidate]:
    src_title_n = normalize_title(song.title)
    src_artist_n = normalize_artist(song.artists)
    for c in candidates:
        c.title_score = fuzz.token_set_ratio(src_title_n, normalize_title(c.title))
        c.artist_score = fuzz.token_set_ratio(src_artist_n, normalize_artist(c.artists))
        c.duration_score = _duration_score(song.duration_sec, c.duration_seconds, cfg)
        combined = (
            cfg["weight_title"] * c.title_score
            + cfg["weight_artist"] * c.artist_score
            + cfg["weight_duration"] * c.duration_score
        )
        if c.resultType == "song":
            combined += cfg["song_result_bonus"]
        c.combined = combined
    # Tie-break: combined desc -> duration closeness (score desc) -> song>video -> stable order
    candidates.sort(
        key=lambda c: (
            -c.combined,
            -c.duration_score,
            0 if c.resultType == "song" else 1,
        )
    )
    return candidates


def match_song(song: Song, yt, cfg: dict | None = None) -> MatchResult:
    """Search YT Music for `song` and bucket the best candidate.

    `yt` is a YTMusic client (or any object exposing .search(...)).
    """
    cfg = {**DEFAULT_CONFIG, **(cfg or {})}
    query = f"{song.title} {song.artists}".strip()
    version_tag = song.version_tag or detect_version_tag(song.title)

    video_fallback = False
    raw = yt.search(query, filter="songs", limit=cfg["search_limit"]) or []
    candidates = _extract_candidates(raw, allow_video=False)

    if not candidates:
        raw = yt.search(query, limit=cfg["search_limit"]) or []
        candidates = _extract_candidates(raw, allow_video=True)
        video_fallback = any(c.resultType == "video" for c in candidates)

    if not candidates:
        logger.info("NOT_FOUND (no results): %s - %s", song.title, song.artists)
        return MatchResult(decision=NOT_FOUND, version_tag=version_tag, reason="no_results")

    candidates = _score_candidates(song, candidates, cfg)
    best = candidates[0]
    runner_up = candidates[1] if len(candidates) > 1 else None
    is_video_pick = video_fallback and best.resultType == "video"

    if best.combined >= cfg["auto_combined_threshold"] and best.artist_score >= cfg["auto_artist_threshold"]:
        decision = AUTO
    elif best.combined >= cfg["review_combined_threshold"]:
        decision = REVIEW
    else:
        decision = NOT_FOUND

    logger.info(
        "%s: '%s' - '%s' -> chosen='%s'/'%s' combined=%.1f artist=%.1f dur=%.1f%s | runner_up=%s",
        decision,
        song.title,
        song.artists,
        best.title,
        best.artists,
        best.combined,
        best.artist_score,
        best.duration_score,
        " [video_fallback]" if is_video_pick else "",
        f"'{runner_up.title}' ({runner_up.combined:.1f})" if runner_up else "none",
    )

    return MatchResult(
        decision=decision,
        chosen=best,
        runner_up=runner_up,
        video_fallback=is_video_pick,
        version_tag=version_tag,
        reason="scored",
    )
