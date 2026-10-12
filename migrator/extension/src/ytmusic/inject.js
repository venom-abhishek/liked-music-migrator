// Runs in the MAIN world of a music.youtube.com tab (same JS context as the
// page itself). This is deliberate: it makes every youtubei/v1 call
// same-origin, so no CORS, no preflight, no anti-CSRF token is needed — the
// same mechanism music.youtube.com's own page scripts use.
//
// SECURITY: never log, persist, or transmit the computed SAPISIDHASH value or
// the raw __Secure-3PAPISID cookie. Nothing in this file may console.log
// either one, including for debugging. Do not add such logging later.
//
// This file only performs reads/writes and reports back structured results
// (HTTP status + parsed JSON body) to bridge.js via window.postMessage. It
// intentionally has no knowledge of chrome.* extension APIs — it can't,
// since MAIN-world scripts don't get them.

(() => {
  const ORIGIN = "https://music.youtube.com";
  const SELF_ORIGIN = window.location.origin;
  const RESPONSE_SOURCE = "ytm-ext-inject-response";
  const REQUEST_SOURCE = "ytm-ext-bridge-request";

  function getCookie(name) {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function computeSapisidHash(sapisid, origin) {
    const ts = Math.floor(Date.now() / 1000);
    const input = `${ts} ${sapisid} ${origin}`;
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${ts}_${hex}`;
  }

  async function callInnertube(endpoint, extraBody, urlExtraParams = "") {
    if (!window.ytcfg || typeof window.ytcfg.get !== "function") {
      throw new Error(
        "ytcfg is not available on this page. Make sure this tab has finished " +
          "loading music.youtube.com, then try again."
      );
    }
    const sapisid = getCookie("__Secure-3PAPISID");
    if (!sapisid) {
      throw new Error(
        "Not signed in: the __Secure-3PAPISID cookie is missing. Log into " +
          "music.youtube.com in this tab, then try again."
      );
    }
    const apiKey = window.ytcfg.get("INNERTUBE_API_KEY");
    const context = window.ytcfg.get("INNERTUBE_CONTEXT");
    const visitorData = window.ytcfg.get("VISITOR_DATA");
    if (!apiKey || !context) {
      throw new Error("Could not read INNERTUBE_API_KEY / INNERTUBE_CONTEXT from ytcfg.");
    }

    // Computed fresh per request; never cached, logged, or sent anywhere but
    // this one Authorization header.
    const hashValue = await computeSapisidHash(sapisid, ORIGIN);

    const headers = {
      Authorization: `SAPISIDHASH ${hashValue}`,
      "X-Origin": ORIGIN,
      "X-Goog-Visitor-Id": visitorData || "",
      "Content-Type": "application/json",
    };
    // Which signed-in Google account (and, for brand accounts, which
    // channel) this tab is using. Without these, a browser signed into
    // several Google accounts would have every call act on the FIRST
    // account, whichever one this tab is showing. Both values are read from
    // the page's own ytcfg, the same place YT Music's web client gets them.
    // Neither is a secret.
    const sessionIndex = window.ytcfg.get("SESSION_INDEX");
    if (sessionIndex != null && sessionIndex !== "") headers["X-Goog-AuthUser"] = String(sessionIndex);
    const delegatedSessionId = window.ytcfg.get("DELEGATED_SESSION_ID");
    if (delegatedSessionId) headers["X-Goog-PageId"] = String(delegatedSessionId);

    const url = `${ORIGIN}/youtubei/v1/${endpoint}?alt=json&key=${encodeURIComponent(apiKey)}${urlExtraParams}`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, ...extraBody }),
    });

    let data = null;
    try {
      data = await resp.json();
    } catch (_e) {
      // Non-JSON or empty body; leave data as null, status/ok still meaningful.
    }
    return { status: resp.status, ok: resp.ok, data };
  }

  function validatePlaylistId(playlistId) {
    return playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
  }

  const ACTIONS = {
    // Connection check for the UI: is the page ready, and is someone signed
    // in? Returns booleans only — never the cookie or any token.
    status: async () => ({
      ready: !!(window.ytcfg && typeof window.ytcfg.get === "function"),
      signedIn:
        !!getCookie("__Secure-3PAPISID") &&
        !(window.ytcfg && typeof window.ytcfg.get === "function" && window.ytcfg.get("LOGGED_IN") === false),
    }),
    // Liked Songs is a synthetic playlist with the fixed browseId "VLLM".
    browseLikedSongs: () => callInnertube("browse", { browseId: "VLLM" }),
    likeSong: (videoId) => callInnertube("like/like", { target: { videoId } }),
    removeLikeSong: (videoId) => callInnertube("like/removelike", { target: { videoId } }),

    // Generic reads, used by the manager for both playlists and Liked Songs.
    browse: (browseId) => callInnertube("browse", { browseId }),
    // `params` is the filter token (e.g. the "songs" filter); omit for an
    // unfiltered search across all result types.
    search: (query, params) => callInnertube("search", params ? { query, params } : { query }),
    // "2025-style" continuation used when paging a playlist/Liked-Songs track
    // list: the continuation token replaces browseId in the POST body.
    browseContinuationBody: (continuation) => callInnertube("browse", { continuation }),
    // Older-style continuation used when paging the library-playlists grid:
    // the original body is resent, and the token goes in the URL query string.
    browseContinuationUrl: (browseId, continuation) =>
      callInnertube("browse", { browseId }, `&ctoken=${continuation}&continuation=${continuation}`),

    // Playlist mutations (bodies ported from ytmusicapi's mixins/playlists.py).
    createPlaylist: (title, description, privacyStatus) =>
      callInnertube("playlist/create", { title, description, privacyStatus: privacyStatus || "PRIVATE" }),
    deletePlaylist: (playlistId) => callInnertube("playlist/delete", { playlistId: validatePlaylistId(playlistId) }),
    addPlaylistItems: (playlistId, videoIds) =>
      callInnertube("browse/edit_playlist", {
        playlistId: validatePlaylistId(playlistId),
        actions: videoIds.map((videoId) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId })),
      }),
    // `items`: [{ videoId, setVideoId }] — both required, per ytmusicapi.
    removePlaylistItems: (playlistId, items) =>
      callInnertube("browse/edit_playlist", {
        playlistId: validatePlaylistId(playlistId),
        actions: items.map((it) => ({
          setVideoId: it.setVideoId,
          removedVideoId: it.videoId,
          action: "ACTION_REMOVE_VIDEO",
        })),
      }),
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== REQUEST_SOURCE) return;

    const { requestId, action, args } = msg;
    const fn = ACTIONS[action];
    try {
      if (!fn) throw new Error(`Unknown action: ${action}`);
      const result = await fn(...(args || []));
      window.postMessage(
        { source: RESPONSE_SOURCE, requestId, ok: true, result },
        SELF_ORIGIN
      );
    } catch (err) {
      window.postMessage(
        { source: RESPONSE_SOURCE, requestId, ok: false, error: String((err && err.message) || err) },
        SELF_ORIGIN
      );
    }
  });
})();
