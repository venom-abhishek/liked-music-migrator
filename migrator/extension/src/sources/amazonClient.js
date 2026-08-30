// UI-page-side wrapper for talking to sources/amazon-bridge.js.

const UI_REQUEST_SOURCE = "amzn-ext-ui-request";

export class AmazonNotFoundError extends Error {}
export class AmazonCallError extends Error {}

const AMAZON_URL_PATTERN = /^https:\/\/music\.amazon\.[a-z.]+\//i;

export async function findAmazonTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && AMAZON_URL_PATTERN.test(t.url)) || null;
}

async function call(tabId, action, args) {
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { source: UI_REQUEST_SOURCE, action, args });
  } catch (err) {
    throw new AmazonCallError(`Couldn't reach the Amazon Music tab (${err.message || err}). Try reloading it.`);
  }
  if (!resp || !resp.ok) {
    throw new AmazonCallError((resp && resp.error) || "No response from the Amazon Music tab.");
  }
  return resp;
}

export function makeAmazonClient(tabId) {
  if (!tabId) throw new AmazonNotFoundError("No open Amazon Music tab.");
  return {
    startCapture: () => call(tabId, "startCapture"),
    stopCapture: () => call(tabId, "stopCapture"),
    getCaptures: () => call(tabId, "getCaptures").then((r) => r.captures || []),
    clearCaptures: () => call(tabId, "clearCaptures"),
    scrollStep: (pxPerStep, waitMs) => call(tabId, "scrollStep", [pxPerStep, waitMs]),
    getPageInfo: () => call(tabId, "getPageInfo"),
  };
}
