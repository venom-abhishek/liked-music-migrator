// UI-page-side wrapper around the bridge.js <-> inject.js message protocol.
// This is the only place the manager UI talks to chrome.tabs; everything
// else works with plain JS objects.

const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

export class YtMusicNotFoundError extends Error {}
export class YtMusicCallError extends Error {}

export async function findYtMusicTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  return tabs[0] || null;
}

async function call(tabId, action, args = []) {
  const resp = await chrome.tabs.sendMessage(tabId, { source: UI_REQUEST_SOURCE, action, args });
  if (!resp || !resp.ok) {
    throw new YtMusicCallError((resp && resp.error) || "no response from YT Music tab");
  }
  const { status, ok, data } = resp.result;
  if (!ok) {
    const message = data && data.error && data.error.message ? data.error.message : `HTTP ${status}`;
    throw new YtMusicCallError(message);
  }
  return data;
}

/** Thin, typed façade over inject.js's ACTIONS. `tabId` must come from findYtMusicTab(). */
export function makeYtMusicClient(tabId) {
  if (!tabId) throw new YtMusicNotFoundError("No open music.youtube.com tab.");
  return {
    browse: (browseId) => call(tabId, "browse", [browseId]),
    browseContinuationBody: (continuation) => call(tabId, "browseContinuationBody", [continuation]),
    browseContinuationUrl: (browseId, continuation) => call(tabId, "browseContinuationUrl", [browseId, continuation]),
    likeSong: (videoId) => call(tabId, "likeSong", [videoId]),
    removeLikeSong: (videoId) => call(tabId, "removeLikeSong", [videoId]),
    createPlaylist: (title, description, privacyStatus) =>
      call(tabId, "createPlaylist", [title, description, privacyStatus]),
    deletePlaylist: (playlistId) => call(tabId, "deletePlaylist", [playlistId]),
    addPlaylistItems: (playlistId, videoIds) => call(tabId, "addPlaylistItems", [playlistId, videoIds]),
    removePlaylistItems: (playlistId, items) => call(tabId, "removePlaylistItems", [playlistId, items]),
  };
}
