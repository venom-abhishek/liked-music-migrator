// The one unfinished import, saved as it goes, so closing the tab (or the
// browser) mid-way doesn't throw away the matching work. Kept in its own
// IndexedDB database so the action log's database never needs a schema
// change. (Replaces the 2026-10 ChatGPT build's "saved preview", which
// rewrote the whole preview into chrome.storage after every song and could
// run out of space.)
//
// Holds only song lists and match results: no credentials, nothing that
// could change the music library by itself. A draft is a starting point the
// user resumes and reviews; nothing in it is ever written without the
// normal final confirmation.

const DB_NAME = "music-mover-drafts";
const STORE = "drafts";
const KEY = "current";
export const DRAFT_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let result;
      const req = fn(t.objectStore(STORE));
      if (req) req.onsuccess = () => (result = req.result);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDraft(draft) {
  await run("readwrite", (s) => s.put({ ...draft, draftVersion: DRAFT_VERSION, savedAt: new Date().toISOString() }, KEY));
}

/** The saved draft, or null if there is none (or it's from an incompatible version). */
export async function loadDraft() {
  const d = await run("readonly", (s) => s.get(KEY));
  if (!d || d.draftVersion !== DRAFT_VERSION || !Array.isArray(d.matches) || !d.sourceKey) return null;
  return d;
}

export async function clearDraft() {
  await run("readwrite", (s) => s.delete(KEY));
}
