// Runs in the MAIN world of an Amazon Music tab, at document_start — the
// timing is load-bearing. Amazon's own web player bundle captures a private
// reference to the native fetch/XMLHttpRequest during its own init, which
// runs as soon as the page's scripts execute; patching window.fetch AFTER
// that point (e.g. from a later-injected script) never affects code already
// holding the original reference. document_start content scripts run before
// the page's own <script> tags execute, so this patch installs first and
// the app's bundle captures OUR wrapped version instead.
//
// This module does NOT construct or sign any Amazon request itself — that
// was tried and abandoned (see migrator/PHASE3_AMAZON_DISCOVERY.md): Amazon's
// internal "Skyfire" API validates a call against server-side session state
// built up by a preceding sequence of calls, not just per-request auth
// fields, so a from-scratch request can never be made to look genuine from
// outside that sequence. Instead: let the page make its own real,
// already-authenticated calls (as the operator browses their library
// normally, or is auto-scrolled through it), and read the RESPONSES.
//
// SECURITY: this only ever reads response bodies (the data the operator is
// already looking at on screen) — never request bodies/headers, which is
// where Amazon's access tokens live. Nothing here touches or transmits an
// auth credential.

(() => {
  const CAPTURE_URL_PATTERN = /skill\.music\.a2z\.com\/api\//;
  // Only responses that actually carry track rows are kept (every one the
  // extractor can use contains trackAsin deeplinks). Amazon's page also makes
  // a steady stream of other calls to the same API (playback, volume,
  // interaction pings) that would otherwise crowd the buffer out.
  const TRACK_DATA_MARKER = "trackAsin";
  const MAX_BUFFERED = 300;
  const POST_SOURCE = "amzn-ext-capture";

  // Recording is ALWAYS on, from document_start. It used to switch on only
  // when the UI's Capture button was clicked — but by then the page has
  // already fetched (and missed) the first screenful of tracks, which for a
  // playlist that loads in one response is ALL of them. So every response is
  // kept, tagged with the page it arrived on, and Capture asks for the ones
  // belonging to the page currently open.
  const buffer = [];

  function currentPageKey() {
    return location.origin + location.pathname;
  }

  function record(url, method, bodyText) {
    if (!bodyText || bodyText.indexOf(TRACK_DATA_MARKER) === -1) return;
    buffer.push({ url, method, body: bodyText, pageKey: currentPageKey(), timestamp: Date.now() });
    if (buffer.length > MAX_BUFFERED) buffer.shift();
    window.postMessage({ source: POST_SOURCE, type: "capture", url, method }, window.location.origin);
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input && input.url;
  }

  // ---- fetch ----
  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await nativeFetch.apply(this, args);
    try {
      const url = requestUrl(args[0]);
      if (url && CAPTURE_URL_PATTERN.test(url)) {
        const method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
        const clone = resp.clone();
        clone
          .text()
          .then((text) => record(url, method, text))
          .catch(() => {});
      }
    } catch (_e) {
      // never let capture failures break the page's own request
    }
    return resp;
  };

  // ---- XMLHttpRequest (fallback in case the bundle uses XHR for some calls) ----
  const NativeXHR = window.XMLHttpRequest;
  const origOpen = NativeXHR.prototype.open;
  const origSend = NativeXHR.prototype.send;
  NativeXHR.prototype.open = function (method, url, ...rest) {
    this.__amznMethod = method;
    this.__amznUrl = url instanceof URL ? url.href : String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  NativeXHR.prototype.send = function (body) {
    if (this.__amznUrl && CAPTURE_URL_PATTERN.test(this.__amznUrl)) {
      this.addEventListener("loadend", () => {
        try {
          record(this.__amznUrl, this.__amznMethod, this.responseText || "");
        } catch (_e) {}
      });
    }
    return origSend.call(this, body);
  };

  // Defensive addition per the lead's direction: if calls turn out to
  // originate from a dedicated Worker (a separate JS global our patches
  // above can't reach at all), at least surface that a Worker was created
  // so the bridge/UI can report it rather than silently capturing nothing.
  const NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = function (...args) {
      window.postMessage({ source: POST_SOURCE, type: "worker-created", scriptUrl: String(args[0]) }, window.location.origin);
      return new NativeWorker(...args);
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "amzn-ext-bridge-request") return;
    const { requestId, action, args } = msg;
    let result;
    switch (action) {
      case "getCaptures": {
        // Captures for the page open right now, by default. A page that was
        // reached by in-app navigation can have its first response tagged
        // with the previous page if Amazon fetched before updating the URL;
        // the UI suggests reloading the Amazon tab when nothing is found,
        // which makes the first response arrive on the right URL.
        const allPages = args && args[0] && args[0].allPages;
        const key = currentPageKey();
        result = { ok: true, pageKey: key, captures: allPages ? buffer.slice() : buffer.filter((c) => c.pageKey === key) };
        break;
      }
      case "countCaptures": {
        const key = currentPageKey();
        result = { ok: true, count: buffer.filter((c) => c.pageKey === key).length };
        break;
      }
      case "clearCaptures":
        buffer.length = 0;
        result = { ok: true };
        break;
      default:
        result = { ok: false, error: `Unknown action: ${action}` };
    }
    window.postMessage({ source: "amzn-ext-inject-response", requestId, ...result }, window.location.origin);
  });
})();
