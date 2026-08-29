// JioSaavn inventory + hydration + Song-shape conversion. Ported from
// extractors/jiosaavn.py, proven against a real 792-track library (see
// PROGRESS_REPORT.md §2.1/§2.2): count-drift tolerance for unhydratable
// (region-locked/removed) tracks, and HTML-entity decoding on every text
// field, which the real migration found necessary for ~12% of rows.

import { decodeHtmlEntities, detectVersionTag } from "./normalize.js";

const HYDRATE_BATCH_SIZE = 50;
const COUNT_DRIFT_TOLERANCE = 5;

export class CountMismatchError extends Error {}

/** Cheap listing: liked-songs id count + every playlist's name/id/track count, no hydration yet. */
export async function getJioSaavnInventory(client) {
  const likedIds = await client.getLikedIds();
  const playlists = await client.getPlaylists();
  return {
    liked: { count: likedIds.length, ids: likedIds },
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, count: p.contentIds.length, contentIds: p.contentIds })),
  };
}

async function hydrateAll(client, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += HYDRATE_BATCH_SIZE) {
    const batch = ids.slice(i, i + HYDRATE_BATCH_SIZE);
    const songs = await client.hydrate(batch);
    out.push(...songs);
  }
  return out;
}

function checkCount(label, captured, expected, warnings) {
  const gap = expected - captured;
  if (gap === 0) return;
  if (Math.abs(gap) > COUNT_DRIFT_TOLERANCE) {
    throw new CountMismatchError(
      `${label}: expected ${expected}, captured ${captured} — ${Math.abs(gap)} ` +
        `${gap > 0 ? "missing" : "extra"} (exceeds drift tolerance of ${COUNT_DRIFT_TOLERANCE}, likely a real capture bug)`
    );
  }
  warnings.push(
    `${label}: expected ${expected}, captured ${captured} — ${Math.abs(gap)} ` +
      `${gap > 0 ? "missing" : "extra"} (within tolerance; likely unavailable/region-locked tracks)`
  );
}

function toSong(raw, collectionType, collectionName) {
  if (raw.type !== "song") return null;
  const more = raw.more_info || {};
  const artistMap = more.artistMap || {};
  const names = [
    ...(artistMap.primary_artists || []).map((a) => a.name).filter(Boolean),
    ...(artistMap.featured_artists || []).map((a) => a.name).filter(Boolean),
  ];
  const dedupedNames = [...new Set(names)];
  const title = decodeHtmlEntities(raw.title || "");
  const duration = more.duration;
  return {
    source: "jiosaavn",
    collection_type: collectionType,
    collection_name: collectionName,
    source_id: raw.id || "",
    title,
    artists: decodeHtmlEntities(dedupedNames.join(", ")),
    album: decodeHtmlEntities(more.album || ""),
    duration_sec: duration ? parseInt(duration, 10) : null,
    version_tag: detectVersionTag(title),
  };
}

/**
 * Hydrates and converts the selected collections into Song-shape objects.
 * `selection`: { liked: boolean, playlists: [{ name, contentIds }] } — from
 * getJioSaavnInventory's result, filtered down to what the user picked.
 */
export async function extractJioSaavnSongs(client, selection) {
  const songs = [];
  const warnings = [];

  if (selection.liked) {
    const hydrated = await hydrateAll(client, selection.liked.ids);
    checkCount("Liked Songs", hydrated.length, selection.liked.ids.length, warnings);
    for (const raw of hydrated) {
      const s = toSong(raw, "liked", "Liked Songs");
      if (s) songs.push(s);
    }
  }

  for (const p of selection.playlists || []) {
    const hydrated = await hydrateAll(client, p.contentIds);
    checkCount(`Playlist '${p.name}'`, hydrated.length, p.contentIds.length, warnings);
    for (const raw of hydrated) {
      const s = toSong(raw, "playlist", p.name);
      if (s) songs.push(s);
    }
  }

  return { songs, warnings };
}
