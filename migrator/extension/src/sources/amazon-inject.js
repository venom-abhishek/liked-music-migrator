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

  // ---- Second, independent way in: read the rows off the page itself ----
  //
  // Amazon's web player turns the same Skyfire row data into web components
  // whose attributes/properties carry the same fields (primaryText,
  // secondaryText1/2/3, a link containing trackAsin). Reading those works
  // even when the network data isn't captured (a cached page, a response
  // shape we don't recognise). The list is virtualised — rows scrolled away
  // are removed — so rows are collected on every scroll step and kept,
  // per page. Looked up by field name, not by element name, so a renamed
  // component still works. Runs in the MAIN world so it can see component
  // properties as well as attributes.
  const domRows = new Map(); // pageKey -> Map(rowKey -> row)
  const headings = new Map(); // pageKey -> the list's name as shown on the page
  const MAX_NODES = 60000;
  const DURATION_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const ASIN_RE = /[?&]trackAsin=([A-Z0-9]{8,})/;

  function field(el, attr, prop) {
    const a = el.getAttribute && el.getAttribute(attr);
    if (a != null && a !== "") return a;
    try {
      const v = el[prop];
      return typeof v === "string" ? v : null;
    } catch (_e) {
      return null;
    }
  }

  function linkText(el) {
    const parts = [];
    for (const attr of ["primary-href", "href", "primary-link", "secondary-href-1", "data-href"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) parts.push(v);
    }
    try {
      for (const prop of ["primaryHref", "primaryLink", "href"]) {
        const v = el[prop];
        if (typeof v === "string") parts.push(v);
        else if (v && typeof v.deeplink === "string") parts.push(v.deeplink);
      }
    } catch (_e) {}
    const a = el.querySelector && el.querySelector("a[href*='trackAsin']");
    if (a) parts.push(a.getAttribute("href"));
    return parts.join(" ");
  }

  function scanDom() {
    const key = currentPageKey();
    if (!domRows.has(key)) domRows.set(key, new Map());
    const rows = domRows.get(key);
    let budget = MAX_NODES;
    const visit = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.currentNode; el && budget-- > 0; el = walker.nextNode()) {
        if (el.nodeType === 1) {
          if (!headings.has(key)) {
            const headline = el.getAttribute && el.getAttribute("headline");
            if (headline && headline.trim()) headings.set(key, headline.trim().slice(0, 200));
          }
          const title = field(el, "primary-text", "primaryText");
          if (title && title.trim()) {
            const artist = field(el, "secondary-text-1", "secondaryText1") || "";
            const album = field(el, "secondary-text-2", "secondaryText2") || "";
            const third = field(el, "secondary-text-3", "secondaryText3") || field(el, "duration", "duration") || "";
            const asin = (ASIN_RE.exec(linkText(el)) || [])[1] || null;
            // Only song rows: they carry a track link or a duration. (The
            // page header and album/artist tiles have primary text too.)
            if (asin || DURATION_RE.test(third.trim())) {
              const rowKey = asin || `${title}|${artist}|${album}`;
              if (!rows.has(rowKey)) rows.set(rowKey, { asin, title: title.trim(), artist: artist.trim(), album: album.trim(), duration: DURATION_RE.test(third.trim()) ? third.trim() : "", order: rows.size });
            }
          }
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      }
    };
    visit(document.documentElement);
    return rows.size;
  }

  function pageHeading() {
    // The playlist's name as shown on the page, for naming the import:
    // a "headline" attribute anywhere (found during scanDom, which also
    // looks inside shadow roots), else a plain heading.
    const key = currentPageKey();
    if (headings.has(key)) return headings.get(key);
    const h = document.querySelector("[headline], music-detail-header, h1");
    const t = h && (h.getAttribute("headline") || h.getAttribute("primary-text") || h.textContent);
    return (t || "").trim().slice(0, 200) || null;
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
      case "scanDom":
        result = { ok: true, count: scanDom() };
        break;
      case "getDomRows": {
        scanDom();
        const rows = domRows.get(currentPageKey());
        result = { ok: true, rows: rows ? [...rows.values()] : [], heading: pageHeading() };
        break;
      }
      case "clearCaptures":
        buffer.length = 0;
        domRows.clear();
        headings.clear();
        result = { ok: true };
        break;
      default:
        result = { ok: false, error: `Unknown action: ${action}` };
    }
    window.postMessage({ source: "amzn-ext-inject-response", requestId, ...result }, window.location.origin);
  });
})();
