// UI-page-side wrapper for talking to sources/jiosaavn.js. Simpler than
// ytmusic/client.js: jiosaavn.js is an isolated-world content script that
// already has chrome.runtime access directly, so there's no bridge/MAIN-world
// relay to go through — just chrome.tabs.sendMessage straight to it.

import { mostRecentTab, sendWithTimeout, YtMusicTimeoutError } from "../ytmusic/client.js";

const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

export class JioSaavnNotFoundError extends Error {}
export class JioSaavnCallError extends Error {}

export async function findJioSaavnTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.jiosaavn.com/*", "https://*.jiosaavn.com/*"],
  });
  return mostRecentTab(tabs);
}

async function call(action, args = []) {
  const tab = await findJioSaavnTab();
  if (!tab) {
    throw new JioSaavnNotFoundError("No open jiosaavn.com tab. Open one, log in, and try again.");
  }
  let resp;
  try {
    resp = await sendWithTimeout(
      tab.id,
      { source: UI_REQUEST_SOURCE, action, args },
      action === "ping" ? 8000 : 60000,
      "The JioSaavn tab isn't responding. Reload that tab, then try again."
    );
  } catch (err) {
    if (err instanceof YtMusicTimeoutError) throw new JioSaavnCallError(err.message);
    throw new JioSaavnCallError(`Couldn't reach the JioSaavn tab (${err.message || err}). Try reloading it.`);
  }
  if (!resp || !resp.ok) {
    throw new JioSaavnCallError((resp && resp.error) || "No response from the JioSaavn tab.");
  }
  return resp.result;
}

export function makeJioSaavnClient() {
  return {
    ping: () => call("ping"),
    getLikedIds: () => call("getLikedIds"),
    getPlaylists: () => call("getPlaylists"),
    hydrate: (ids) => call("hydrate", [ids]),
  };
}
