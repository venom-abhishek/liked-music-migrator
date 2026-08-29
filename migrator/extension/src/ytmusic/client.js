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

export async function findYtMusicTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  return tabs[0] || null;
}

async function call(action, args = []) {
  const tab = await findYtMusicTab();
  if (!tab) {
    throw new YtMusicNotFoundError("No open music.youtube.com tab. Open one, log in, and try again.");
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { source: UI_REQUEST_SOURCE, action, args });
  } catch (err) {
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

/** Thin, typed façade over inject.js's ACTIONS. Stateless — safe to create once and reuse. */
export function makeYtMusicClient() {
  return {
    browse: (browseId) => call("browse", [browseId]),
    browseContinuationBody: (continuation) => call("browseContinuationBody", [continuation]),
    browseContinuationUrl: (browseId, continuation) => call("browseContinuationUrl", [browseId, continuation]),
    likeSong: (videoId) => call("likeSong", [videoId]),
    removeLikeSong: (videoId) => call("removeLikeSong", [videoId]),
    createPlaylist: (title, description, privacyStatus) =>
      call("createPlaylist", [title, description, privacyStatus]),
    deletePlaylist: (playlistId) => call("deletePlaylist", [playlistId]),
    addPlaylistItems: (playlistId, videoIds) => call("addPlaylistItems", [playlistId, videoIds]),
    removePlaylistItems: (playlistId, items) => call("removePlaylistItems", [playlistId, items]),
  };
}
