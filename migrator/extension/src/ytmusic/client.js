// UI-page-side wrapper around the bridge.js <-> inject.js message protocol.
// This is the only place the manager UI talks to chrome.tabs; everything
// else works with plain JS objects.
//
// Every call re-resolves the YT Music tab fresh rather than caching a tabId
// at page-load time. Caching it was the original design and it caused a real
// bug: if the tab closed/reopened, navigated, or the extension was reloaded
// while the manager page stayed open, every action after that failed until
// the user manually hit "Refresh" (the only code path that re-resolved the
// tab). Re-resolving per call costs one cheap chrome.tabs.query and removes
// the whole "have to refresh a lot" class of failure.

const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

export class YtMusicNotFoundError extends Error {}
export class YtMusicCallError extends Error {}
export class YtMusicTimeoutError extends YtMusicCallError {}

// How long to wait for the YouTube Music tab to answer before giving up.
// Without a limit, a frozen or half-loaded YouTube Music tab made every
// screen spin forever. Reads and searches normally answer in 1-2 seconds;
// writes get longer because a big playlist add can legitimately take a
// while — and a write that is given up on too early may still go through.
const TIMEOUT_MS = { status: 8000, read: 45000, write: 120000 };
const WRITE_ACTIONS = new Set(["likeSong", "removeLikeSong", "createPlaylist", "deletePlaylist", "addPlaylistItems", "removePlaylistItems"]);

export const NOT_RESPONDING =
  "The YouTube Music tab isn't responding. Reload that tab (or close it and open music.youtube.com again), then try again.";

/** chrome.tabs.sendMessage with a time limit. */
export function sendWithTimeout(tabId, message, ms, notRespondingMessage = NOT_RESPONDING) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new YtMusicTimeoutError(notRespondingMessage)), ms);
  });
  return Promise.race([chrome.tabs.sendMessage(tabId, message), timeout]).finally(() => clearTimeout(timer));
}

/** Of several matching tabs, the one the user touched most recently (tabs[0] is arbitrary). */
export function mostRecentTab(tabs) {
  if (!tabs || tabs.length === 0) return null;
  return tabs.reduce((best, t) => ((t.lastAccessed || 0) > (best.lastAccessed || 0) ? t : best));
}

export async function findYtMusicTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  return mostRecentTab(tabs);
}

async function call(action, args = []) {
  const tab = await findYtMusicTab();
  if (!tab) {
    throw new YtMusicNotFoundError("No open music.youtube.com tab. Open one, log in, and try again.");
  }

  let resp;
  try {
    const ms = WRITE_ACTIONS.has(action) ? TIMEOUT_MS.write : TIMEOUT_MS.read;
    resp = await sendWithTimeout(tab.id, { source: UI_REQUEST_SOURCE, action, args }, ms);
  } catch (err) {
    if (err instanceof YtMusicTimeoutError) throw err;
    // Most commonly "Could not establish connection. Receiving end does not
    // exist." — the tab exists but bridge.js hasn't (re-)injected into it
    // yet (e.g. right after a browser/extension restart). Reloading the tab
    // fixes this; surface that plainly instead of a raw Chrome error.
    throw new YtMusicCallError(
      `Couldn't reach the YouTube Music tab (${err.message || err}). Try reloading that tab.`
    );
  }

  if (!resp || !resp.ok) {
    throw new YtMusicCallError((resp && resp.error) || "No response from the YouTube Music tab.");
  }
  const { status, ok, data } = resp.result;
  if (!ok) {
    const message = data && data.error && data.error.message ? data.error.message : `HTTP ${status}`;
    throw new YtMusicCallError(message);
  }
  return data;
}

// browse/edit_playlist answers HTTP 200 even when it refused the edit (e.g.
// adding a song that's already in the playlist makes it return a "this is
// already in your playlist" dialog instead of adding anything). The real
// outcome is in the body's `status` — ytmusicapi checks for "SUCCEEDED" in
// it the same way. Treat anything else as a failure rather than reporting
// (and logging) an edit that never happened.
function assertEditSucceeded(data, what) {
  const status = data && data.status;
  if (status && !String(status).includes("SUCCEEDED")) {
    throw new YtMusicCallError(`YouTube Music refused to ${what} (status: ${status}).`);
  }
  return data;
}

/** Thin, typed façade over inject.js's ACTIONS. Stateless — safe to create once and reuse. */
export function makeYtMusicClient() {
  return {
    // Raw call without the HTTP-result unwrapping — `status` returns plain data, not an API response.
    status: async () => {
      const tab = await findYtMusicTab();
      if (!tab) throw new YtMusicNotFoundError("No open music.youtube.com tab. Open one, log in, and try again.");
      let resp;
      try {
        resp = await sendWithTimeout(tab.id, { source: UI_REQUEST_SOURCE, action: "status", args: [] }, TIMEOUT_MS.status);
      } catch (err) {
        if (err instanceof YtMusicTimeoutError) throw err;
        throw new YtMusicCallError(`Couldn't reach the YouTube Music tab (${err.message || err}). Try reloading that tab.`);
      }
      if (!resp || !resp.ok) throw new YtMusicCallError((resp && resp.error) || "No response from the YouTube Music tab.");
      return resp.result;
    },
    browse: (browseId) => call("browse", [browseId]),
    browseContinuationBody: (continuation) => call("browseContinuationBody", [continuation]),
    browseContinuationUrl: (browseId, continuation) => call("browseContinuationUrl", [browseId, continuation]),
    search: (query, params) => call("search", [query, params]),
    likeSong: (videoId) => call("likeSong", [videoId]),
    removeLikeSong: (videoId) => call("removeLikeSong", [videoId]),
    // playlist/create's raw response is a big object (actions, tracking
    // params, etc.) with the new id at .playlistId — every caller wants just
    // the id (this bit ytmusicapi's own create_playlist() unwraps the same
    // way), so unwrap it here rather than in every call site.
    // privacyStatus defaults to PRIVATE here, not only in inject.js: an
    // omitted argument crosses chrome.tabs.sendMessage as null, which
    // bypasses inject.js's default and sent `privacyStatus: null`.
    createPlaylist: async (title, description, privacyStatus = "PRIVATE") => {
      const data = await call("createPlaylist", [title, description, privacyStatus]);
      return (data && data.playlistId) || data;
    },
    deletePlaylist: (playlistId) => call("deletePlaylist", [playlistId]),
    addPlaylistItems: async (playlistId, videoIds) =>
      assertEditSucceeded(await call("addPlaylistItems", [playlistId, videoIds]), "add the track(s) to the playlist"),
    removePlaylistItems: async (playlistId, items) =>
      assertEditSucceeded(await call("removePlaylistItems", [playlistId, items]), "remove the track(s) from the playlist"),
  };
}
