// Deterministic search + scoring + bucket decision. No AI, no LLM calls —
// port of engine/matcher.py, proven on a real 792-track migration.

import { normalizeTitle, normalizeArtist, detectVersionTag } from "./normalize.js";
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
    c.combined = combined;
  }
  candidates.sort((a, b) => {
    if (b.combined !== a.combined) return b.combined - a.combined;
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

  return { decision, chosen: best, runnerUp, videoFallback: isVideoPick, versionTag, reason: "scored" };
}
