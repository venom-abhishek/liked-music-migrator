// Deterministic search + scoring + bucket decision. No AI, no LLM calls —
// port of engine/matcher.py, proven on a real 792-track migration.

import { normalizeTitle, normalizeArtist, detectVersionTag, songKey } from "./normalize.js";
import { tokenSetRatio } from "./fuzz.js";
import { SONGS_FILTER_PARAM, parseSearchResults } from "../ytmusic/parsers.js";

export const AUTO = "AUTO";
export const REVIEW = "REVIEW";
export const NOT_FOUND = "NOT_FOUND";

export const DEFAULT_CONFIG = {
  autoCombinedThreshold: 85,
  autoArtistThreshold: 70,
  reviewCombinedThreshold: 70,
  durationExactToleranceSec: 3,
  durationMaxToleranceSec: 15,
  durationNeutralScore: 70,
  weightTitle: 0.5,
  weightArtist: 0.35,
  weightDuration: 0.15,
  songResultBonus: 5,
  searchLimit: 5,
  // An otherwise-AUTO match whose runner-up (a different video) scores within
  // this many points goes to REVIEW: too close to call without a human.
  minimumMargin: 4,
};

// Version tags that make a recording genuinely different. "remaster" and
// "explicit" are left out on purpose: YouTube Music titles often carry them
// for what is the same recording a user would want.
const DISTINCT_VERSION_TAGS = new Set(["remix", "live", "acoustic", "cover", "sped_up", "instrumental"]);
const distinctTag = (title) => {
  const tag = detectVersionTag(title);
  return DISTINCT_VERSION_TAGS.has(tag) ? tag : "";
};

function durationScore(srcDur, candDur, cfg) {
  if (srcDur == null || candDur == null) return cfg.durationNeutralScore;
  const diff = Math.abs(srcDur - candDur);
  const exact = cfg.durationExactToleranceSec;
  const maxTol = cfg.durationMaxToleranceSec;
  if (diff <= exact) return 100;
  if (diff >= maxTol) return 0;
  const span = maxTol - exact;
  return 100 * (1 - (diff - exact) / span);
}

function extractCandidates(parsedResults, allowVideo) {
  const out = [];
  for (const r of parsedResults) {
    if (r.resultType !== "song" && r.resultType !== "video") continue;
    if (r.resultType === "video" && !allowVideo) continue;
    if (!r.videoId) continue;
    out.push({
      videoId: r.videoId,
      title: r.title || "",
      artists: (r.artists || []).map((a) => a.name).filter(Boolean).join(", "), // matcher.py skips empty names too
      album: r.album ? r.album.name : "",
      duration_seconds: r.duration_seconds ?? null,
      resultType: r.resultType,
      titleScore: 0,
      artistScore: 0,
      durationScore: 0,
      combined: 0,
    });
  }
  return out;
}

function scoreCandidates(song, candidates, cfg) {
  const srcTitleN = normalizeTitle(song.title);
  const srcArtistN = normalizeArtist(song.artists);
  for (const c of candidates) {
    c.titleScore = tokenSetRatio(srcTitleN, normalizeTitle(c.title));
    c.artistScore = tokenSetRatio(srcArtistN, normalizeArtist(c.artists));
    c.durationScore = durationScore(song.duration_sec, c.duration_seconds, cfg);
    let combined = cfg.weightTitle * c.titleScore + cfg.weightArtist * c.artistScore + cfg.weightDuration * c.durationScore;
    if (c.resultType === "song") combined += cfg.songResultBonus;
    // Raw score for ranking and the margin check; the shown score is capped
    // at 100 (the song bonus can push a perfect match to 105). Capping before
    // sorting would turn clear winners into ties.
    c.rawCombined = combined;
    c.combined = Math.min(100, combined);
  }
  candidates.sort((a, b) => {
    if (b.rawCombined !== a.rawCombined) return b.rawCombined - a.rawCombined;
    if (b.durationScore !== a.durationScore) return b.durationScore - a.durationScore;
    return (a.resultType === "song" ? 0 : 1) - (b.resultType === "song" ? 0 : 1);
  });
  return candidates;
}

/**
 * Searches YT Music for `song` (via `client`, a ytmusic/client.js instance)
 * and buckets the best candidate into AUTO / REVIEW / NOT_FOUND.
 */
export async function matchSong(song, client, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const query = `${song.title} ${song.artists}`.trim();
  const versionTag = song.version_tag || detectVersionTag(song.title);

  let videoFallback = false;
  let raw = await client.search(query, SONGS_FILTER_PARAM);
  let candidates = extractCandidates(parseSearchResults(raw), false);

  if (candidates.length === 0) {
    raw = await client.search(query, null);
    candidates = extractCandidates(parseSearchResults(raw), true);
    videoFallback = candidates.some((c) => c.resultType === "video");
  }

  if (candidates.length === 0) {
    return { decision: NOT_FOUND, chosen: null, runnerUp: null, videoFallback: false, versionTag, reason: "no_results" };
  }

  scoreCandidates(song, candidates, cfg);
  const best = candidates[0];
  const runnerUp = candidates[1] || null;
  const isVideoPick = videoFallback && best.resultType === "video";

  let decision;
  if (best.combined >= cfg.autoCombinedThreshold && best.artistScore >= cfg.autoArtistThreshold) {
    decision = AUTO;
  } else if (best.combined >= cfg.reviewCombinedThreshold) {
    decision = REVIEW;
  } else {
    decision = NOT_FOUND;
  }

  // Extra caution before anything is written without a human looking at it
  // (ported from the 2026-10 ChatGPT review): an otherwise-AUTO match goes to
  // REVIEW if it is a different version (live vs studio etc.), only a video,
  // nearly tied with a different candidate, or the source had no artist.
  let reason = "scored";
  if (decision === AUTO) {
    if (distinctTag(best.title) !== distinctTag(song.title)) reason = "version_mismatch";
    else if (isVideoPick) reason = "video_fallback";
    // Near-tie with a DIFFERENT song only. YouTube Music often lists the same
    // song twice (album version and single); either is right, so that alone
    // shouldn't send it to a person.
    else if (runnerUp && songKey(runnerUp.title, runnerUp.artists) !== songKey(best.title, best.artists) && best.rawCombined - runnerUp.rawCombined < cfg.minimumMargin) reason = "ambiguous_candidates";
    else if (!normalizeArtist(song.artists)) reason = "missing_artist";
    if (reason !== "scored") decision = REVIEW;
  }

  return { decision, chosen: best, runnerUp, candidates: candidates.slice(0, cfg.searchLimit), videoFallback: isVideoPick, versionTag, reason };
}
