// Runs as an isolated-world content script on music.youtube.com — the relay
// between the extension UI page (which has chrome.* APIs but no page access)
// and inject.js (which has page access but no chrome.* APIs).
//
// Isolated and MAIN world content scripts share the same DOM `window`, so
// window.postMessage is the bridge between them.

(() => {
  const REQUEST_SOURCE = "ytm-ext-bridge-request";
  const RESPONSE_SOURCE = "ytm-ext-inject-response";
  const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

  let counter = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== RESPONSE_SOURCE) return;
    const resolve = pending.get(msg.requestId);
    if (!resolve) return;
    pending.delete(msg.requestId);
    resolve(msg);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== UI_REQUEST_SOURCE) return false;

    const requestId = `req_${Date.now()}_${counter++}`;
    // Forget requests that never got an answer, so they don't pile up. The
    // UI side (client.js) gives up sooner and tells the user; this is only
    // cleanup, set longer than the UI's longest wait.
    const timer = setTimeout(() => {
      pending.delete(requestId);
      sendResponse({ ok: false, error: "The YouTube Music tab isn't responding." });
    }, 150000);
    pending.set(requestId, (response) => {
      clearTimeout(timer);
      sendResponse(response);
    });
    window.postMessage(
      { source: REQUEST_SOURCE, requestId, action: message.action, args: message.args },
      window.location.origin
    );
    return true; // keep the message channel open for the async sendResponse above
  });
})();
