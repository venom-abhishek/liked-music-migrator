// Applies the three destination modes and writes AUTO matches, deduping
// against existing YT state and within the current run. Port of writer.py's
// role, adapted to batch playlist adds into one API call per destination
// (YT Music's edit_playlist endpoint accepts multiple actions per request —
// the old Python tool went one-at-a-time with a sleep between each because
// it had to be gentle across a whole CLI run; a single batched call per
// destination here is both faster and exactly what YT Music's own
// multi-select "add to playlist" does).

import { AUTO } from "./matcher.js";
import { songKey } from "./normalize.js";
import { fetchAllTracks } from "./reconcile.js";
import { playlistIdToBrowseId } from "../ytmusic/parsers.js";
import { logAction, ACTION_TYPES } from "../storage/log.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function destinationFor(song, mode, singlePlaylistName) {
  if (mode === "liked") return { kind: "liked" };
  if (mode === "single") return { kind: "playlist", name: singlePlaylistName };
  // mirror
  return song.collection_type === "liked" ? { kind: "liked" } : { kind: "playlist", name: song.collection_name };
}

function toLogTrack(entry) {
  return {
    videoId: entry.videoId,
    setVideoId: entry.setVideoId || null,
    title: entry.song.title,
    artistsDisplay: entry.song.artists,
    album: entry.song.album,
  };
}

/**
 * Writes every AUTO-matched entry to its destination(s).
 * `matched`: [{ song, match }] — match.decision must be AUTO (caller filters).
 * `existingLibrary`: { likedTracks, playlists: [{title, id}] } — preloaded
 * via reconcile.js's fetchAllTracks(VLLM)/fetchAllLibraryPlaylists so
 * "already in your library" is checked against real current state, not a
 * separate ledger (the Python tool's separate ledger-based dedup check
 * turned out to be redundant dead weight in practice — see PROGRESS_REPORT
 * §2.3 — live-state comparison is what actually did the work).
 * Reports progress per destination group via `onProgress(text)`.
 */
export async function commitImport(client, matched, mode, singlePlaylistName, existingLibrary, onProgress) {
  const results = [];
  const likedVideoIds = new Set(existingLibrary.likedTracks.map((t) => t.videoId));
  const likedKeys = new Set(existingLibrary.likedTracks.map((t) => songKey(t.title, t.artistsDisplay)));
  const playlistsByName = new Map(existingLibrary.playlists.map((p) => [p.title, p]));

  const groups = new Map(); // "liked" | "playlist:<name>" -> { destMeta, entries: [{song, match}] }
  for (const item of matched) {
    const destMeta = destinationFor(item.song, mode, singlePlaylistName);
    const key = destMeta.kind === "liked" ? "liked" : `playlist:${destMeta.name}`;
    if (!groups.has(key)) groups.set(key, { destMeta, entries: [] });
    groups.get(key).entries.push(item);
  }

  for (const { destMeta, entries } of groups.values()) {
    onProgress?.(`Writing to "${destMeta.kind === "liked" ? "Liked Music" : destMeta.name}"…`);

    if (destMeta.kind === "liked") {
      const candidates = entries.map((e) => ({ song: e.song, videoId: e.match.chosen.videoId }));
      const toAdd = dedupeAgainstAndWithinRun(candidates, likedVideoIds, likedKeys, results, entries);
      for (const c of toAdd) {
        try {
          await client.likeSong(c.videoId);
          await sleep(150);
          results.push({ song: c.song, outcome: "added" });
          likedVideoIds.add(c.videoId);
          likedKeys.add(songKey(c.song.title, c.song.artists));
        } catch (err) {
          results.push({ song: c.song, outcome: "error", error: String(err.message || err) });
        }
      }
      if (toAdd.length) {
        await logAction(
          ACTION_TYPES.IMPORT,
          { kind: "jiosaavn", id: "import", title: "JioSaavn import" },
          { kind: "liked", id: "LM", title: "Liked Music" },
          toAdd.map((c) => toLogTrack(c))
        );
      }
      continue;
    }

    // playlist destination
    let playlistMeta = playlistsByName.get(destMeta.name);
    let playlistId;
    let createdNew = false;
    if (playlistMeta) {
      playlistId = playlistMeta.id;
    } else {
      playlistId = await client.createPlaylist(destMeta.name, "Imported by YT Music Manager & Migrator");
      createdNew = true;
      playlistsByName.set(destMeta.name, { id: playlistId, title: destMeta.name });
    }

    let existingVideoIds = new Set();
    let existingKeys = new Set();
    if (!createdNew) {
      const tracks = await fetchAllTracks(client, playlistIdToBrowseId(playlistId));
      tracks.forEach((t) => {
        existingVideoIds.add(t.videoId);
        existingKeys.add(songKey(t.title, t.artistsDisplay));
      });
    }

    const candidates = entries.map((e) => ({ song: e.song, videoId: e.match.chosen.videoId }));
    const toAdd = dedupeAgainstAndWithinRun(candidates, existingVideoIds, existingKeys, results, entries);

    if (toAdd.length) {
      const addResp = await client.addPlaylistItems(playlistId, toAdd.map((c) => c.videoId));
      const setVideoIdByVideoId = {};
      for (const r of addResp.playlistEditResults || []) {
        const data = r && r.playlistEditVideoAddedResultData;
        if (data && data.videoId && data.setVideoId) setVideoIdByVideoId[data.videoId] = data.setVideoId;
      }
      toAdd.forEach((c) => {
        c.setVideoId = setVideoIdByVideoId[c.videoId] || null;
        results.push({ song: c.song, outcome: "added" });
      });
      await logAction(
        ACTION_TYPES.IMPORT,
        { kind: "jiosaavn", id: "import", title: "JioSaavn import" },
        { kind: "playlist", id: playlistId, title: destMeta.name },
        toAdd.map((c) => toLogTrack(c)),
        createdNew ? { createdPlaylistId: playlistId } : {}
      );
    } else if (createdNew) {
      await logAction(ACTION_TYPES.PLAYLIST_CREATE, null, { kind: "playlist", id: playlistId, title: destMeta.name }, [], {
        createdPlaylistId: playlistId,
      });
    }
  }

  return results;
}

function dedupeAgainstAndWithinRun(candidates, existingVideoIds, existingKeys, results, entries) {
  const seen = new Set();
  const toAdd = [];
  candidates.forEach((c, i) => {
    const key = songKey(c.song.title, c.song.artists);
    if (existingVideoIds.has(c.videoId) || existingKeys.has(key)) {
      results.push({ song: c.song, outcome: "already_present" });
      return;
    }
    if (seen.has(c.videoId) || seen.has(key)) {
      results.push({ song: c.song, outcome: "duplicate" });
      return;
    }
    seen.add(c.videoId);
    seen.add(key);
    toAdd.push(c);
  });
  return toAdd;
}
