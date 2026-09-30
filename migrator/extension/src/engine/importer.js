// Applies the three destination modes and writes AUTO matches, deduping
// against existing YT state and within the current run. Port of writer.py's
// role, adapted to batch playlist adds (YT Music's edit_playlist endpoint
// accepts multiple actions per request — the old Python tool went
// one-at-a-time with a sleep between each; batching is both faster and what
// YT Music's own multi-select "add to playlist" does).

import { songKey } from "./normalize.js";
import { fetchAllTracks } from "./reconcile.js";
import { playlistIdToBrowseId } from "../ytmusic/parsers.js";
import { startAction, saveAction, finishAction, ACTION_TYPES } from "../storage/log.js";

// Playlist adds go in chunks rather than one call for the whole group, so a
// very large import doesn't depend on one huge request being accepted, and
// so progress is logged as each chunk lands.
const ADD_CHUNK_SIZE = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function destinationFor(song, mode, singlePlaylistName) {
  if (mode === "liked") return { kind: "liked" };
  if (mode === "single") return { kind: "playlist", name: singlePlaylistName };
  // mirror
  return song.collection_type === "liked" ? { kind: "liked" } : { kind: "playlist", name: song.collection_name };
}

function toLogTrack(c) {
  return {
    videoId: c.videoId,
    setVideoId: null,
    title: c.song.title,
    artistsDisplay: c.song.artists,
    album: c.song.album,
    added: false,
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
 * `sourceMeta`: { kind, title } for the action log, e.g. { kind: "amazon", title: "Amazon Music" }.
 * Reports progress per destination group via `onProgress(text)`, and hands
 * each action-log record to `onRecord(record)` as it's created (the UI uses
 * these for its "Undo this import" button).
 *
 * Logging is write-ahead (see storage/log.js): each destination's action
 * record exists before its first write, and each track is flagged `added`
 * as soon as its write succeeds — so a failure partway leaves an accurate,
 * undoable record of exactly what did get written.
 */
export async function commitImport(client, matched, mode, singlePlaylistName, existingLibrary, onProgress, sourceMeta, onRecord) {
  const source = {
    kind: (sourceMeta && sourceMeta.kind) || "import",
    id: "import",
    title: `${(sourceMeta && sourceMeta.title) || "External"} import`,
  };
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
    const destLabel = destMeta.kind === "liked" ? "Liked Music" : destMeta.name;
    onProgress?.(`Writing to "${destLabel}"…`);

    if (destMeta.kind === "liked") {
      const candidates = entries.map((e) => ({ song: e.song, videoId: e.match.chosen.videoId }));
      const toAdd = dedupeAgainstAndWithinRun(candidates, likedVideoIds, likedKeys, results);
      if (toAdd.length === 0) continue;
      const record = await startAction(ACTION_TYPES.IMPORT, source, { kind: "liked", id: "LM", title: "Liked Music" }, toAdd.map(toLogTrack));
      onRecord?.(record);
      let firstError = null;
      for (let i = 0; i < toAdd.length; i++) {
        const c = toAdd[i];
        try {
          await client.likeSong(c.videoId);
          record.tracks[i].added = true;
          await saveAction(record);
          await sleep(150);
          results.push({ song: c.song, outcome: "added" });
          likedVideoIds.add(c.videoId);
          likedKeys.add(songKey(c.song.title, c.song.artists));
        } catch (err) {
          firstError = firstError || err;
          results.push({ song: c.song, outcome: "error", error: String(err.message || err) });
        }
        onProgress?.(`Writing to "${destLabel}": ${i + 1}/${toAdd.length}…`);
      }
      await finishAction(record, firstError);
      continue;
    }

    // playlist destination
    const existing = playlistsByName.get(destMeta.name);
    let existingVideoIds = new Set();
    let existingKeys = new Set();
    if (existing) {
      const tracks = await fetchAllTracks(client, playlistIdToBrowseId(existing.id));
      tracks.forEach((t) => {
        existingVideoIds.add(t.videoId);
        existingKeys.add(songKey(t.title, t.artistsDisplay));
      });
    }

    const candidates = entries.map((e) => ({ song: e.song, videoId: e.match.chosen.videoId }));
    const toAdd = dedupeAgainstAndWithinRun(candidates, existingVideoIds, existingKeys, results);
    if (toAdd.length === 0) continue;

    // Record first, then create the playlist (if needed) and record its id
    // straight away — so even if every add below fails, the new playlist is
    // on record and undo can delete it.
    const record = await startAction(
      ACTION_TYPES.IMPORT,
      source,
      { kind: "playlist", id: existing ? existing.id : null, title: destMeta.name },
      toAdd.map(toLogTrack)
    );
    onRecord?.(record);
    let playlistId = existing && existing.id;
    let firstError = null;
    try {
      if (!playlistId) {
        playlistId = await client.createPlaylist(destMeta.name, "Imported by YT Music Manager & Migrator");
        record.createdPlaylistId = playlistId;
        record.destination.id = playlistId;
        await saveAction(record);
        playlistsByName.set(destMeta.name, { id: playlistId, title: destMeta.name });
      }

      for (let start = 0; start < toAdd.length; start += ADD_CHUNK_SIZE) {
        const chunk = toAdd.slice(start, start + ADD_CHUNK_SIZE);
        onProgress?.(`Writing to "${destLabel}": ${Math.min(start + chunk.length, toAdd.length)}/${toAdd.length}…`);
        const addResp = await client.addPlaylistItems(playlistId, chunk.map((c) => c.videoId));
        const setVideoIdByVideoId = {};
        for (const r of addResp.playlistEditResults || []) {
          const data = r && r.playlistEditVideoAddedResultData;
          if (data && data.videoId && data.setVideoId) setVideoIdByVideoId[data.videoId] = data.setVideoId;
        }
        chunk.forEach((c, j) => {
          const logTrack = record.tracks[start + j];
          logTrack.added = true;
          logTrack.setVideoId = setVideoIdByVideoId[c.videoId] || null;
          results.push({ song: c.song, outcome: "added" });
        });
        await saveAction(record);
      }
    } catch (err) {
      firstError = err;
      record.tracks.forEach((t, j) => {
        if (!t.added) results.push({ song: toAdd[j].song, outcome: "error", error: String(err.message || err) });
      });
    }
    await finishAction(record, firstError);
  }

  return results;
}

function dedupeAgainstAndWithinRun(candidates, existingVideoIds, existingKeys, results) {
  const seen = new Set();
  const toAdd = [];
  candidates.forEach((c) => {
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
