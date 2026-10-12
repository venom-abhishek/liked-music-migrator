// Small pure helpers for the "My music" screen. Kept out of the UI code so
// they can be unit-tested. (duplicateExtras is adapted from the 2026-10
// ChatGPT review.)

/**
 * The extra copies of songs that appear more than once in a list, i.e.
 * every occurrence after the first of the same video. `tracks` should be
 * in playlist order, so the copy that was added first is the one kept.
 * Only exact same-video copies count: two different uploads of a song
 * might be a deliberate choice (a live take, a different mix), so they're
 * never selected automatically.
 */
export function duplicateExtras(tracks) {
  const seen = new Set();
  return tracks.filter((t) => {
    if (!t.videoId) return false;
    if (seen.has(t.videoId)) return true;
    seen.add(t.videoId);
    return false;
  });
}

// ---- Backup files ----
//
// A backup is a JSON file of one playlist (or Liked songs) made by "Save a
// copy". Because it records YouTube Music's own video ids, bringing it back
// in needs no searching: the exact same songs are re-added. (Format and
// checks adapted from the 2026-10 ChatGPT review; the version-1 layout is
// unchanged so files made by either build load in both.)

export const BACKUP_MAX_TRACKS = 50000;

/** Builds the backup file text for one collection. */
export function toBackupJson(collection, tracks, now = new Date()) {
  return JSON.stringify(
    {
      version: 1,
      app: "Music Mover",
      exportedAt: now.toISOString(),
      collection: { kind: collection.kind, id: collection.id, title: collection.title },
      tracks: tracks.map((t) => ({
        title: t.title,
        artistsDisplay: t.artistsDisplay || "",
        album: t.album || "",
        duration_seconds: Number.isFinite(t.duration_seconds) ? t.duration_seconds : null,
        videoId: t.videoId,
        setVideoId: t.setVideoId || null,
      })),
    },
    null,
    1
  );
}

/**
 * Reads a backup file's text. Returns { title, kind, exportedAt, songs }
 * where songs are in the importer's Song shape plus `videoId`. Throws an
 * Error with a plain-language message if the file isn't a usable backup.
 */
export function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (_e) {
    throw new Error("This file isn't a Music Mover backup (it couldn't be read).");
  }
  if (!value || value.version !== 1 || !Array.isArray(value.tracks)) {
    throw new Error("This file isn't a Music Mover backup.");
  }
  if (value.tracks.length > BACKUP_MAX_TRACKS) throw new Error(`This backup has more than ${BACKUP_MAX_TRACKS.toLocaleString()} songs, which is too many to bring in at once.`);
  const kind = value.collection && value.collection.kind === "liked" ? "liked" : "playlist";
  const title = String((value.collection && value.collection.title) || (kind === "liked" ? "Liked songs" : "Restored playlist"));
  const songs = value.tracks.map((t, i) => {
    if (!t || typeof t.title !== "string" || !t.title.trim()) throw new Error(`Song number ${i + 1} in this backup has no title, so the file looks damaged.`);
    return {
      source: "backup",
      collection_type: kind,
      collection_name: title,
      source_id: typeof t.videoId === "string" ? t.videoId : "",
      videoId: typeof t.videoId === "string" && t.videoId ? t.videoId : null,
      title: t.title,
      artists: String(t.artistsDisplay ?? t.artists ?? ""),
      album: String(t.album ?? ""),
      duration_sec: Number.isFinite(t.duration_seconds) ? t.duration_seconds : null,
      version_tag: "",
    };
  });
  return { title, kind, exportedAt: value.exportedAt || null, songs };
}

// ---- Artists ----

/**
 * Every credited artist in a list with how many songs they're on, most
 * songs first. Uses each track's individual artist credits (so "A, B"
 * counts for both A and B), falling back to the display string.
 */
export function artistCounts(tracks) {
  const counts = new Map();
  for (const t of tracks) {
    const names = (t.artists && t.artists.length ? t.artists.map((a) => a.name) : [t.artistsDisplay]).filter(Boolean);
    for (const name of new Set(names)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Tracks credited to any of `names`. */
export function tracksByArtists(tracks, names) {
  const want = new Set(names);
  return tracks.filter((t) => (t.artists && t.artists.length ? t.artists.map((a) => a.name) : [t.artistsDisplay]).some((n) => want.has(n)));
}
