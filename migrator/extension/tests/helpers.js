// Shared fixtures for the unit tests: builders for the slices of YouTube
// Music's browse/search responses the parsers read, a fake YT Music client
// that records every call, and a minimal in-memory IndexedDB (just the
// surface storage/log.js uses) so the action log can run under Node.

export function trackItem({ videoId, setVideoId, title, artist = "Artist", album = "Album", duration = "3:30" }) {
  const renderer = {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }] } } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: {
            runs: [
              {
                text: artist,
                navigationEndpoint: {
                  browseEndpoint: {
                    browseId: "UC_artist",
                    browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } },
                  },
                },
              },
            ],
          },
        },
      },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: {
            runs: [
              {
                text: album,
                navigationEndpoint: {
                  browseEndpoint: {
                    browseId: "MPRE_album",
                    browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } },
                  },
                },
              },
            ],
          },
        },
      },
    ],
    fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: duration }] } } }],
    overlay: {
      musicItemThumbnailOverlayRenderer: {
        content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId } } } },
      },
    },
  };
  if (setVideoId) {
    renderer.menu = {
      menuRenderer: {
        items: [
          {
            menuServiceItemRenderer: {
              serviceEndpoint: { playlistEditEndpoint: { actions: [{ setVideoId, removedVideoId: videoId }] } },
            },
          },
        ],
      },
    };
  }
  return { musicResponsiveListItemRenderer: renderer };
}

function continuationItem(token) {
  return { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } };
}

/** A playlist `browse` response; `pages` is an array of arrays of trackItem() args. */
export function playlistPages(pages) {
  const first = pages[0].map(trackItem);
  if (pages.length > 1) first.push(continuationItem("tok1"));
  const firstResponse = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: first } }] } },
      },
    },
  };
  const continuations = {};
  for (let i = 1; i < pages.length; i++) {
    const items = pages[i].map(trackItem);
    if (i < pages.length - 1) items.push(continuationItem(`tok${i + 1}`));
    continuations[`tok${i}`] = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] };
  }
  return { firstResponse, continuations };
}

/**
 * Fake ytmusic/client.js. `playlists`: { [playlistId]: [{videoId, setVideoId, title}] }
 * (use "LM" for Liked Songs). Mutations update that state and are recorded
 * in `calls` so tests can assert on order.
 */
export function fakeYtClient(playlists = {}) {
  const calls = [];
  let nextSet = 1000;
  const state = JSON.parse(JSON.stringify(playlists));
  const browseIdToPlaylist = (browseId) => (browseId === "VLLM" ? "LM" : browseId.replace(/^VL/, ""));
  return {
    calls,
    state,
    browse: async (browseId) => {
      const id = browseIdToPlaylist(browseId);
      if (!(id in state)) throw new Error(`HTTP 404 for ${browseId}`);
      return playlistPages([state[id]]).firstResponse;
    },
    browseContinuationBody: async () => ({}),
    likeSong: async (videoId) => {
      calls.push(["like", videoId]);
      state.LM = state.LM || [];
      if (!state.LM.some((t) => t.videoId === videoId)) state.LM.push({ videoId, title: videoId });
    },
    removeLikeSong: async (videoId) => {
      calls.push(["unlike", videoId]);
      state.LM = (state.LM || []).filter((t) => t.videoId !== videoId);
    },
    addPlaylistItems: async (playlistId, videoIds) => {
      calls.push(["add", playlistId, [...videoIds]]);
      const results = videoIds.map((videoId) => {
        const setVideoId = `SV${nextSet++}`;
        state[playlistId].push({ videoId, setVideoId, title: videoId });
        return { playlistEditVideoAddedResultData: { videoId, setVideoId } };
      });
      return { status: "STATUS_SUCCEEDED", playlistEditResults: results };
    },
    removePlaylistItems: async (playlistId, items) => {
      calls.push(["remove", playlistId, items.map((i) => i.videoId)]);
      const drop = new Set(items.map((i) => i.setVideoId));
      state[playlistId] = state[playlistId].filter((t) => !drop.has(t.setVideoId));
      return { status: "STATUS_SUCCEEDED" };
    },
    createPlaylist: async (title) => {
      const id = `PLnew${nextSet++}`;
      calls.push(["create", title, id]);
      state[id] = [];
      return id;
    },
    deletePlaylist: async (playlistId) => {
      calls.push(["delete", playlistId]);
      delete state[playlistId];
    },
  };
}

/** Installs a minimal in-memory globalThis.indexedDB (fresh on each call). */
export function installFakeIndexedDb() {
  const stores = new Map(); // storeName -> Map(key -> record)
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, { keyPath }) {
      const map = new Map();
      map.keyPath = keyPath;
      stores.set(name, map);
      return { createIndex() {} };
    },
    // Requests queue synchronously and all run on the next tick, followed by
    // the transaction's oncomplete — the same ordering a real IDB guarantees.
    transaction(name) {
      const map = stores.get(name);
      const ops = [];
      const t = { oncomplete: null, onerror: null, onabort: null };
      const op = (fn) => {
        const req = { onsuccess: null, result: undefined };
        ops.push(() => {
          req.result = fn();
          req.onsuccess && req.onsuccess();
        });
        return req;
      };
      t.objectStore = () => ({
        add: (rec) =>
          op(() => {
            if (map.has(rec[map.keyPath])) throw new Error("ConstraintError");
            map.set(rec[map.keyPath], clone(rec));
          }),
        put: (rec) => op(() => map.set(rec[map.keyPath], clone(rec))),
        get: (key) => op(() => clone(map.get(key))),
        getAll: () => op(() => [...map.values()].map(clone)),
      });
      setTimeout(() => {
        try {
          ops.forEach((run) => run());
          t.oncomplete && t.oncomplete();
        } catch (e) {
          t.error = e;
          t.onerror && t.onerror();
        }
      }, 0);
      return t;
    },
    close() {},
  };
  globalThis.indexedDB = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      setTimeout(() => {
        if (!stores.size && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
  return stores;
}
