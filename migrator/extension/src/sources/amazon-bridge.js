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

  function callInject(action, args) {
    return new Promise((resolve) => {
      const requestId = `req_${Date.now()}_${counter++}`;
      // These are instant, in-memory calls; no answer within a few seconds
      // means amazon-inject.js isn't running in this tab (e.g. the tab was
      // opened before the extension was installed or reloaded).
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "The capture script isn't running in this Amazon tab. Reload the Amazon tab and try again." });
      }, 5000);
      pending.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      window.postMessage({ source: REQUEST_SOURCE, requestId, action, args }, window.location.origin);
    });
  }

  // Amazon's web player may scroll the whole document, or keep the document
  // fixed and scroll an inner panel (the track list). Scrolling the window in
  // the second case does nothing, which would make the auto-scroll think the
  // list had ended after a few steps. So find what actually scrolls: the
  // document if it can, otherwise the tallest scrollable element, looking
  // inside open shadow roots too (Amazon's UI is built from web components).
  function isScrollable(elem) {
    if (elem.scrollHeight <= elem.clientHeight + 10) return false;
    const oy = getComputedStyle(elem).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }

  function findInnerScroller(root, best, budget) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node && budget.left-- > 0) {
      if (node.nodeType === 1) {
        if (isScrollable(node) && (!best.el || node.scrollHeight > best.el.scrollHeight)) best.el = node;
        if (node.shadowRoot) findInnerScroller(node.shadowRoot, best, budget);
      }
      node = walker.nextNode();
    }
    return best.el;
  }

  function getScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl.scrollHeight > window.innerHeight + 10) return { el: docEl, isDocument: true };
    const inner = findInnerScroller(document.body, { el: null }, { left: 20000 });
    return inner ? { el: inner, isDocument: false } : { el: docEl, isDocument: true };
  }

  async function scrollAndWait(pxPerStep = 1600, waitMs = 900) {
    const { el, isDocument } = getScroller();
    const before = el.scrollHeight;
    if (isDocument) window.scrollBy(0, pxPerStep);
    else el.scrollTop += pxPerStep;
    await new Promise((r) => setTimeout(r, waitMs));
    const after = el.scrollHeight;
    const visible = isDocument ? window.innerHeight : el.clientHeight;
    const top = isDocument ? window.scrollY : el.scrollTop;
    return {
      scrollHeightBefore: before,
      scrollHeightAfter: after,
      atBottom: visible + top >= after - 50,
      scroller: isDocument ? "document" : el.tagName.toLowerCase(),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== UI_REQUEST_SOURCE) return false;

    (async () => {
      switch (message.action) {
        case "getCaptures":
        case "countCaptures":
        case "clearCaptures": {
          const resp = await callInject(message.action, message.args);
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
