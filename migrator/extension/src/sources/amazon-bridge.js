// Isolated-world content script on Amazon Music — relays capture control
// commands to amazon-inject.js (MAIN world) and does DOM scrolling itself
// (isolated-world scripts share the real DOM with the page, just not its JS
// globals, so scrolling doesn't need to go through the MAIN-world relay).

(() => {
  const REQUEST_SOURCE = "amzn-ext-bridge-request";
  const RESPONSE_SOURCE = "amzn-ext-inject-response";
  const UI_REQUEST_SOURCE = "amzn-ext-ui-request";

  let counter = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== RESPONSE_SOURCE) return;
    const resolve = pending.get(msg.requestId);
    if (resolve) {
      pending.delete(msg.requestId);
      resolve(msg);
    }
  });

  function callInject(action) {
    return new Promise((resolve) => {
      const requestId = `req_${Date.now()}_${counter++}`;
      pending.set(requestId, resolve);
      window.postMessage({ source: REQUEST_SOURCE, requestId, action }, window.location.origin);
    });
  }

  async function scrollAndWait(pxPerStep = 1600, waitMs = 900) {
    const before = document.body.scrollHeight;
    window.scrollBy(0, pxPerStep);
    await new Promise((r) => setTimeout(r, waitMs));
    const after = document.body.scrollHeight;
    return { scrollHeightBefore: before, scrollHeightAfter: after, atBottom: window.innerHeight + window.scrollY >= after - 50 };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== UI_REQUEST_SOURCE) return false;

    (async () => {
      switch (message.action) {
        case "startCapture":
        case "stopCapture":
        case "getCaptures":
        case "clearCaptures": {
          const resp = await callInject(message.action);
          sendResponse(resp);
          break;
        }
        case "scrollStep": {
          const result = await scrollAndWait(message.args && message.args[0], message.args && message.args[1]);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "getPageInfo": {
          sendResponse({ ok: true, url: location.href, title: document.title, scrollHeight: document.body.scrollHeight });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown action: ${message.action}` });
      }
    })();

    return true; // keep the channel open for the async sendResponse above
  });
})();
