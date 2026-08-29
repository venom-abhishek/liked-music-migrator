// Content script on jiosaavn.com (default/isolated world — no MAIN-world
// split needed here, unlike YT Music). JioSaavn's API just needs the
// session cookie attached, which a same-origin fetch() does automatically
// via credentials: 'include'; there's no page-context secret to read like
// YT Music's ytcfg, so an isolated content script can do this directly and
// still has chrome.runtime access, unlike a MAIN-world script would.
//
// Endpoints ported from extractors/jiosaavn.py (proven against a real
// account — see PROGRESS_REPORT.md §2.1): reads only, no auth/session
// values ever touched beyond what the browser attaches automatically.

(() => {
  const API_URL = "https://www.jiosaavn.com/api.php";
  const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

  function apiUrl(extraParams) {
    const params = new URLSearchParams({
      api_version: "4",
      _format: "json",
      _marker: "0",
      ctx: "web6dot0",
      ...extraParams,
    });
    return `${API_URL}?${params.toString()}`;
  }

  async function getJson(extraParams) {
    const resp = await fetch(apiUrl(extraParams), { credentials: "include" });
    if (!resp.ok) {
      throw new Error(`JioSaavn API call failed (HTTP ${resp.status}): __call=${extraParams.__call}`);
    }
    return resp.json();
  }

  const ACTIONS = {
    getLikedIds: async () => {
      const data = await getJson({ __call: "library.getAll" });
      // Podcast/show items live under "show", not "song" — reading only
      // "song" already excludes non-music for free.
      const ids = (data && data.song) || [];
      return [...new Set(ids)];
    },

    getPlaylists: async () => {
      const raw = await getJson({
        __call: "playlist.list",
        all_playlists: "true",
        contents: "1",
        onlypids: "true",
      });
      return (raw || []).map((p) => {
        const contents = ((p.more_info || {}).contents || "").split(",").filter(Boolean);
        return {
          id: p.id || "",
          name: p.title || "",
          contentIds: [...new Set(contents)],
        };
      });
    },

    // `ids`: up to ~50 at a time (caller batches) — matches library.getDetails'
    // observed limit, same as the proven Python extractor.
    hydrate: async (ids) => {
      const data = await getJson({
        __call: "library.getDetails",
        entity_ids: ids.join(","),
        entity_type: "song",
        n: String(ids.length || 50),
      });
      return (data && data.songs) || [];
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== UI_REQUEST_SOURCE) return false;
    const fn = ACTIONS[message.action];
    if (!fn) return false;
    fn(...(message.args || []))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // keep the channel open for the async response above
  });
})();
