// Action log + undo, backed by IndexedDB (not chrome.storage.local, which is
// far too small for a log covering a library of thousands of tracks).
// Ports the semantics of engine/ledger.py: every destructive action is
// recorded as a reversible unit, and undo() replays the correct reversal
// primitive per action type — proven on the real account for un-like,
// playlist-item removal, and playlist deletion.
//
// Write-ahead, like ledger.py (which appends each row as soon as it's
// processed): an action's record is written BEFORE its first API call, with
// status "in_progress", and each track's per-step flag (e.g. `unliked`,
// `removedFromSource`) is flipped and persisted as that step succeeds. So if
// an action fails or the page dies halfway, whatever did happen is already
// on record and undoable — and undo only reverses steps that are flagged as
// having happened.
//
// Records written before this scheme existed have no `status` field; for
// those, every step is assumed to have happened (they were only ever logged
// after full success).

import { fetchAllTracks } from "../engine/reconcile.js";
import { playlistIdToBrowseId } from "../ytmusic/parsers.js";

const DB_NAME = "ytm-manager";
const DB_VERSION = 1;
const STORE = "actions";

export const ACTION_TYPES = {
  REMOVE: "remove", // tracks removed from a playlist
  UNLIKE: "unlike", // tracks un-liked (removed from Liked Songs)
  MOVE: "move", // tracks added to destination + removed from source
  PLAYLIST_CREATE: "playlist_create",
  IMPORT: "import", // tracks written to a destination from an external source (JioSaavn / Amazon)
};

export const STATUS = {
  IN_PROGRESS: "in_progress", // written before the first API call; stays this way if the page died mid-action
  COMPLETE: "complete",
  PARTIAL: "partial", // failed partway; the per-track flags say exactly what happened
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "actionId" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      const req = fn(store);
      if (req) req.onsuccess = () => (result = req.result);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

function newActionId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `act_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Writes a new action record BEFORE any API call is made, and returns it.
 * Callers mutate the returned record (per-track step flags, createdPlaylistId,
 * etc.) and persist it with saveAction() as each step succeeds, then close it
 * with finishAction().
 * @param {string} type - one of ACTION_TYPES
 * @param {{kind: string, id: string, title: string}|null} source
 * @param {{kind: string, id: string|null, title: string}|null} destination
 * @param {Array<object>} tracks - display info + videoId/setVideoId per track
 * @param {object} [extra]
 */
export async function startAction(type, source, destination, tracks, extra = {}) {
  const record = {
    actionId: newActionId(),
    type,
    timestamp: new Date().toISOString(),
    status: STATUS.IN_PROGRESS,
    source,
    destination,
    tracks,
    undone: false,
    ...extra,
  };
  await withStore("readwrite", (store) => store.add(record));
  return record;
}

/** Persists the current state of a record returned by startAction(). */
export async function saveAction(record) {
  await withStore("readwrite", (store) => store.put(record));
}

/** Marks a started action complete (or partial, if `error` is given) and persists it. */
export async function finishAction(record, error) {
  record.status = error ? STATUS.PARTIAL : STATUS.COMPLETE;
  if (error) record.error = String((error && error.message) || error);
  await saveAction(record);
}

/** One-shot log of an action that has already fully happened. */
export async function logAction(type, source, destination, tracks, extra = {}) {
  const record = await startAction(type, source, destination, tracks, extra);
  await finishAction(record);
  return record;
}

export async function listActions() {
  const records = (await withStore("readonly", (store) => store.getAll())) || [];
  return records.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

/** True if this track's `flag` step is on record as having happened (legacy records: always true). */
export function stepDone(action, track, flag) {
  if (!action.status) return true;
  return !!track[flag];
}

/** Whether a record has anything that undo could reverse. */
export function hasUndoableEffect(action) {
  if (action.createdPlaylistId) return true;
  if (!action.status) return true;
  const flags = {
    [ACTION_TYPES.REMOVE]: ["removed"],
    [ACTION_TYPES.UNLIKE]: ["unliked"],
    [ACTION_TYPES.MOVE]: ["addedToDest", "removedFromSource"],
    [ACTION_TYPES.IMPORT]: ["added"],
  }[action.type];
  if (!flags) return true;
  return action.tracks.some((t) => flags.some((f) => t[f]));
}

/**
 * Deletes a playlist this tool created — but only if everything in it right
 * now is something `ownVideoIds` put there. A playlist that has since had
 * other tracks added (by a later move/import, or by hand in YouTube Music)
 * is never deleted by undo; that would silently destroy those tracks too.
 * Returns true if deleted, false if it was left alone.
 */
async function deleteCreatedPlaylistIfOnlyOurs(client, playlistId, ownVideoIds) {
  let tracks;
  try {
    tracks = await fetchAllTracks(client, playlistIdToBrowseId(playlistId));
  } catch (_e) {
    // Already gone (deleted by hand) or unreadable — nothing safe to do.
    return false;
  }
  const own = new Set(ownVideoIds);
  if (tracks.every((t) => own.has(t.videoId))) {
    await client.deletePlaylist(playlistId);
    return true;
  }
  return false;
}

function undoProgress(action) {
  if (!action.undoProgress) action.undoProgress = {};
  return action.undoProgress;
}

/**
 * Reverses one logged action against the real account. `client` is a
 * ytmusic/client.js instance. Throws on the first failed call; the record is
 * only marked undone once every reversal step has succeeded.
 *
 * Order is always restore-first, remove-second: if a reversal fails halfway,
 * the worst case is a track temporarily in two places, never a track in
 * neither. Phase progress is persisted on the record, so retrying a
 * half-finished undo doesn't re-add tracks a second time.
 *
 * Undo restores membership, not position: re-adding a track appends it to
 * the end of a playlist. Callers must surface this to the user.
 */
export async function performUndo(client, action) {
  if (action.undone) throw new Error("This action was already undone.");
  const progress = undoProgress(action);
  const notes = [];

  switch (action.type) {
    case ACTION_TYPES.UNLIKE:
      for (const t of action.tracks) {
        if (stepDone(action, t, "unliked")) await client.likeSong(t.videoId);
      }
      break;

    case ACTION_TYPES.REMOVE: {
      const ids = action.tracks.filter((t) => stepDone(action, t, "removed")).map((t) => t.videoId);
      if (ids.length) await client.addPlaylistItems(action.source.id, [...new Set(ids)]);
      break;
    }

    case ACTION_TYPES.MOVE: {
      // 1. Restore to source first.
      if (!progress.sourceRestored) {
        const restore = action.tracks.filter((t) => stepDone(action, t, "removedFromSource"));
        if (action.source.kind === "liked") {
          for (const t of restore) await client.likeSong(t.videoId);
        } else if (restore.length) {
          await client.addPlaylistItems(action.source.id, [...new Set(restore.map((t) => t.videoId))]);
        }
        progress.sourceRestored = true;
        await saveAction(action);
      }
      // 2. Then take back out of the destination only what this move put there.
      const added = action.tracks.filter((t) => stepDone(action, t, "addedToDest"));
      if (action.destination.kind === "liked") {
        for (const t of added) await client.removeLikeSong(t.videoId);
      } else if (action.createdPlaylistId) {
        const deleted = await deleteCreatedPlaylistIfOnlyOurs(client, action.createdPlaylistId, added.map((t) => t.videoId));
        if (!deleted) await removeAddedFromPlaylist(client, action.destination.id, added, "destSetVideoId");
      } else {
        await removeAddedFromPlaylist(client, action.destination.id, added, "destSetVideoId");
      }
      break;
    }

    case ACTION_TYPES.IMPORT: {
      const added = action.tracks.filter((t) => stepDone(action, t, "added"));
      if (action.destination.kind === "liked") {
        for (const t of added) await client.removeLikeSong(t.videoId);
      } else if (action.createdPlaylistId) {
        const deleted = await deleteCreatedPlaylistIfOnlyOurs(client, action.createdPlaylistId, added.map((t) => t.videoId));
        if (!deleted) {
          await removeAddedFromPlaylist(client, action.destination.id, added, "setVideoId");
          notes.push("The playlist it created was kept, because other tracks have been added to it since.");
        }
      } else {
        await removeAddedFromPlaylist(client, action.destination.id, added, "setVideoId");
      }
      break;
    }

    case ACTION_TYPES.PLAYLIST_CREATE: {
      const deleted = await deleteCreatedPlaylistIfOnlyOurs(client, action.createdPlaylistId, []);
      if (!deleted) {
        throw new Error(
          `"${action.destination.title}" isn't empty any more (or no longer exists). Undo the actions that ` +
            "added tracks to it first, or delete it yourself in YouTube Music — undo won't delete a playlist " +
            "with tracks in it."
        );
      }
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  action.undone = true;
  action.undoneAt = new Date().toISOString();
  await saveAction(action);
  return { notes };
}

// Removing a playlist item needs its setVideoId (the id of that one entry in
// that one playlist). Normally recorded from the add call's response; if it
// wasn't returned, look it up from the playlist's current contents, taking
// the LAST copy of the track, since the add appended it to the end.
async function removeAddedFromPlaylist(client, playlistId, tracks, setVideoIdField) {
  if (tracks.length === 0) return;
  const items = [];
  const missing = [];
  for (const t of tracks) {
    if (t[setVideoIdField]) items.push({ videoId: t.videoId, setVideoId: t[setVideoIdField] });
    else missing.push(t);
  }
  if (missing.length) {
    const current = await fetchAllTracks(client, playlistIdToBrowseId(playlistId));
    const lastSetVideoId = new Map();
    for (const t of current) if (t.setVideoId) lastSetVideoId.set(t.videoId, t.setVideoId);
    for (const t of missing) {
      const setVideoId = lastSetVideoId.get(t.videoId);
      if (setVideoId) items.push({ videoId: t.videoId, setVideoId });
      // Not in the playlist at all any more: already removed, nothing to do.
    }
  }
  if (items.length) await client.removePlaylistItems(playlistId, items);
}
