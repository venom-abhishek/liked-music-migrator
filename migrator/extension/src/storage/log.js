// Action log + undo, backed by IndexedDB (not chrome.storage.local, which is
// far too small for a log covering a library of thousands of tracks).
// Ports the semantics of engine/ledger.py: every destructive action is
// recorded as a reversible unit, and undo() replays the correct reversal
// primitive per action type — proven on the real account for un-like,
// playlist-item removal, and playlist deletion.

const DB_NAME = "ytm-manager";
const DB_VERSION = 1;
const STORE = "actions";

export const ACTION_TYPES = {
  REMOVE: "remove", // tracks removed from a playlist
  UNLIKE: "unlike", // tracks un-liked (removed from Liked Songs)
  MOVE: "move", // tracks added to destination + removed from source
  PLAYLIST_CREATE: "playlist_create",
  IMPORT: "import", // tracks written to a destination from an external source (e.g. JioSaavn)
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

function tx(db, mode) {
  const t = db.transaction(STORE, mode);
  return { t, store: t.objectStore(STORE) };
}

function newActionId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `act_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Records one destructive action.
 * @param {string} type - one of ACTION_TYPES
 * @param {{kind: 'liked'|'playlist', id: string, title: string}} source
 * @param {{kind: 'liked'|'playlist', id: string, title: string}|null} destination
 * @param {Array<{videoId: string, setVideoId?: string|null, title: string, artistsDisplay: string, album: string}>} tracks
 * @param {{createdPlaylistId?: string}} [extra]
 */
export async function logAction(type, source, destination, tracks, extra = {}) {
  const db = await openDb();
  const record = {
    actionId: newActionId(),
    type,
    timestamp: new Date().toISOString(),
    source,
    destination,
    tracks,
    undone: false,
    ...extra,
  };
  await new Promise((resolve, reject) => {
    const { t, store } = tx(db, "readwrite");
    store.add(record);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
  return record;
}

export async function listActions() {
  const db = await openDb();
  const records = await new Promise((resolve, reject) => {
    const { store } = tx(db, "readonly");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

async function markUndone(actionId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const { t, store } = tx(db, "readwrite");
    const req = store.get(actionId);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return resolve();
      record.undone = true;
      store.put(record);
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}

/**
 * Reverses one logged action against the real account. `client` is a
 * ytmusic/client.js instance. Throws on the first failed call; nothing is
 * marked undone until every reversal call for this action has succeeded.
 *
 * Undo restores membership, not position: re-adding a track appends it to
 * the end of a playlist. Callers must surface this to the user.
 */
export async function performUndo(client, action) {
  if (action.undone) throw new Error("This action was already undone.");

  const videoIds = action.tracks.map((t) => t.videoId);

  switch (action.type) {
    case ACTION_TYPES.UNLIKE:
      for (const videoId of videoIds) {
        await client.likeSong(videoId);
      }
      break;

    case ACTION_TYPES.REMOVE:
      await client.addPlaylistItems(action.source.id, videoIds);
      break;

    case ACTION_TYPES.MOVE: {
      // Reverse of "add to destination, remove from source": remove from
      // destination, restore to source.
      if (action.destination.kind === "liked") {
        for (const videoId of videoIds) {
          await client.removeLikeSong(videoId);
        }
      } else {
        const items = action.tracks
          .filter((t) => t.destSetVideoId)
          .map((t) => ({ videoId: t.videoId, setVideoId: t.destSetVideoId }));
        if (items.length) await client.removePlaylistItems(action.destination.id, items);
      }

      if (action.source.kind === "liked") {
        for (const videoId of videoIds) {
          await client.likeSong(videoId);
        }
      } else {
        await client.addPlaylistItems(action.source.id, videoIds);
      }
      break;
    }

    case ACTION_TYPES.IMPORT:
      // Reverse of "wrote these tracks to destination": remove them again.
      if (action.destination.kind === "liked") {
        for (const videoId of videoIds) {
          await client.removeLikeSong(videoId);
        }
      } else {
        const items = action.tracks
          .filter((t) => t.setVideoId)
          .map((t) => ({ videoId: t.videoId, setVideoId: t.setVideoId }));
        if (items.length) await client.removePlaylistItems(action.destination.id, items);
      }
      break;

    case ACTION_TYPES.PLAYLIST_CREATE:
      await client.deletePlaylist(action.createdPlaylistId);
      break;

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  await markUndone(action.actionId);
}
