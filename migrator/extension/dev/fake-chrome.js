// DEV ONLY — not loaded by the extension. A stand-in for the chrome.* APIs
// plus fake YouTube Music / JioSaavn / Amazon tabs with realistic data, so
// the UI can be previewed and clicked through in a normal browser without
// any accounts. Used by dev/preview.mjs (screenshots + smoke test).
//
// Scenario is read from window.__scenario (set before this runs), e.g.
//   { yt: "ok" | "missing" | "signed-out" | "reload" | "frozen", jiosaavn: "ok" | "missing", amazon: "ok" | "missing", slow: 0 }
(() => {
  const sc = Object.assign({ yt: "ok", jiosaavn: "ok", amazon: "ok", slow: 0 }, window.__scenario || {});
  window.__calls = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const ARTISTS = ["Arijit Singh", "Shreya Ghoshal", "A.R. Rahman", "Pritam", "Taylor Swift", "Coldplay", "The Weeknd", "Diljit Dosanjh", "Anuv Jain", "Prateek Kuhad"];
  const WORDS = ["Tum", "Hi", "Ho", "Kesariya", "Love", "Night", "Dil", "Raat", "Summer", "Chaand", "Baarish", "Dreams", "Safar", "Mann", "Yellow", "Blinding", "Lights", "Ilahi", "Husn", "Kasoor"];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const song = (i) => {
    seed = (i * 7919 + 13) % 2147483647 || 1;
    rnd();
    const title = `${pick(WORDS)} ${pick(WORDS)}${rnd() < 0.2 ? " (Acoustic)" : ""}`;
    const secs = 150 + Math.floor(rnd() * 150);
    return { videoId: `vid${i}`, title, artist: pick(ARTISTS), album: `${pick(WORDS)} (Original Soundtrack)`, duration: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`, secs };
  };
  const yt = {
    LM: Array.from({ length: 348 }, (_, i) => song(i)),
    PLworkout: Array.from({ length: 25 }, (_, i) => ({ ...song(1000 + i), setVideoId: `s${1000 + i}` })),
    PLchill: Array.from({ length: 60 }, (_, i) => ({ ...song(2000 + i), setVideoId: `s${2000 + i}` })),
    PLroad: Array.from({ length: 1234 }, (_, i) => ({ ...song(3000 + i), setVideoId: `s${3000 + i}` })),
  };
  const titles = { PLworkout: "Workout", PLchill: "Chill evenings", PLroad: "Road trip 2025" };
  let n = 90000;

  const js = { liked: Array.from({ length: 40 }, (_, i) => `js${i}`), playlists: [{ id: "p1", name: "Bollywood Hits", ids: Array.from({ length: 18 }, (_, i) => `jp${i}`) }, { id: "p2", name: "Late night \"lofi\"", ids: Array.from({ length: 9 }, (_, i) => `jq${i}`) }] };
  const jsSong = (id) => {
    const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7);
    const s = song(h % 5000);
    return { id, type: "song", title: s.title.replace("&", "&amp;"), more_info: { album: s.album, duration: String(s.secs), artistMap: { primary_artists: [{ name: s.artist }] } } };
  };

  // --- YT response builders (the slices the parsers read) ---
  const navArtist = (name) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: "UCx", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } });
  const navAlbum = (name) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: "MPREx", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } } });
  const col = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });
  const row = (t, forSearch) => {
    const r = {
      flexColumns: [col([{ text: t.title, navigationEndpoint: { watchEndpoint: { videoId: t.videoId } } }]), col(forSearch ? [navArtist(t.artist), { text: " • " }, navAlbum(t.album), { text: " • " }, { text: t.duration }] : [navArtist(t.artist)]), col([navAlbum(t.album)])],
      fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: t.duration }] } } }],
      overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId: t.videoId } } } } } },
    };
    if (t.setVideoId) r.menu = { menuRenderer: { items: [{ menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { actions: [{ setVideoId: t.setVideoId, removedVideoId: t.videoId }] } } } }] } };
    return { musicResponsiveListItemRenderer: r };
  };
  const PAGE = 100;
  const playlistPage = (id, from) => {
    const items = yt[id].slice(from, from + PAGE).map((t) => row(t));
    if (from + PAGE < yt[id].length) items.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: `${id}|${from + PAGE}` } } } });
    return items;
  };
  const ok = (data) => ({ ok: true, result: { status: 200, ok: true, data } });

  async function ytAction(action, args) {
    window.__calls.push([action, args]);
    if (sc.slow) await wait(sc.slow);
    if (action === "status") return { ok: true, result: { ready: true, signedIn: sc.yt !== "signed-out" } };
    if (sc.yt === "signed-out") return { ok: false, error: "Not signed in: the __Secure-3PAPISID cookie is missing." };
    if (action === "browse" && args[0] === "FEmusic_liked_playlists") {
      const grid = (id) => ({ musicTwoRowItemRenderer: { title: { runs: [{ text: titles[id], navigationEndpoint: { browseEndpoint: { browseId: "VL" + id } } }] }, subtitle: { runs: [{ text: "Playlist" }, { text: " • " }, { text: `${yt[id].length.toLocaleString("en")} songs` }] } } });
      const ids = Object.keys(yt).filter((k) => k !== "LM");
      return ok({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ gridRenderer: { items: [{}, ...ids.map(grid)] } }] } } } }] } } });
    }
    if (action === "browse") {
      const id = args[0] === "VLLM" ? "LM" : args[0].slice(2);
      return ok({
        contents: {
          twoColumnBrowseResultsRenderer: {
            tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: { title: { runs: [{ text: titles[id] || "Liked Music" }] }, secondSubtitle: { runs: [{ text: `${yt[id].length.toLocaleString("en")} songs` }] } } }] } } } }],
            secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: playlistPage(id, 0) } }] } },
          },
        },
      });
    }
    if (action === "browseContinuationBody") {
      const [id, from] = args[0].split("|");
      return ok({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: playlistPage(id, +from) } }] });
    }
    if (action === "search") {
      await wait(40);
      const q = args[0];
      const h = [...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 3);
      const bucket = h % 10; // 0-6 clear match, 7-8 close, 9 nothing
      if (bucket === 9) return ok({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [] } } } }] } } });
      const title = q.split(" ").slice(0, 2).join(" ");
      const artist = q.split(" ").slice(2).join(" ").split(",")[0];
      // "close" results: right artist, only half the title matches — the
      // matcher routes those to "Please check" rather than auto-adding.
      const t = { videoId: `yt${h}`, title: bucket >= 7 ? `${title.split(" ")[0]} Reprise Version` : title, artist, album: "Album", duration: "" };
      return ok({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { title: { runs: [{ text: "Songs" }] }, contents: [row(t, true)] } }] } } } }] } } });
    }
    if (action === "addPlaylistItems") {
      const [pid, vids] = args;
      yt[pid] = yt[pid] || [];
      const res = vids.map((v) => { const s = `SV${n++}`; yt[pid].push({ ...song(n), videoId: v, setVideoId: s }); return { playlistEditVideoAddedResultData: { videoId: v, setVideoId: s } }; });
      return ok({ status: "STATUS_SUCCEEDED", playlistEditResults: res });
    }
    if (action === "removePlaylistItems") {
      const [pid, items] = args;
      const drop = new Set(items.map((i) => i.setVideoId));
      yt[pid] = yt[pid].filter((t) => !drop.has(t.setVideoId));
      return ok({ status: "STATUS_SUCCEEDED" });
    }
    if (action === "createPlaylist") { const id = `PLnew${n++}`; yt[id] = []; titles[id] = args[0]; return ok({ playlistId: id }); }
    if (action === "deletePlaylist") { delete yt[args[0]]; return ok({}); }
    if (action === "likeSong") { if (!yt.LM.some((t) => t.videoId === args[0])) yt.LM.unshift({ ...song(n++), videoId: args[0] }); return ok({}); }
    if (action === "removeLikeSong") { yt.LM = yt.LM.filter((t) => t.videoId !== args[0]); return ok({}); }
    return { ok: false, error: `Unknown action: ${action}` };
  }

  async function jsAction(action, args) {
    window.__calls.push(["js:" + action, args]);
    await wait(150);
    if (action === "ping") return { ok: true, result: { ok: true } };
    if (action === "getLikedIds") return { ok: true, result: js.liked };
    if (action === "getPlaylists") return { ok: true, result: js.playlists.map((p) => ({ id: p.id, name: p.name, contentIds: p.ids })) };
    if (action === "hydrate") return { ok: true, result: args[0].map(jsSong) };
    return { ok: false, error: "Unknown action" };
  }

  async function amzAction(action) {
    window.__calls.push(["amz:" + action]);
    if (action === "getPageInfo") return { ok: true, url: "https://music.amazon.in/user-playlists/abc", title: "Gym Mix | Amazon Music" };
    if (action === "scrollStep") { await wait(80); return { ok: true, scrollHeightBefore: 100, scrollHeightAfter: 100, atBottom: true }; }
    if (action === "countCaptures") return { ok: true, count: 1 };
    if (action === "getCaptures") {
      const rows = Array.from({ length: 22 }, (_, i) => { const s = song(7000 + i); return { interface: "X.VisualRowItemElement", primaryText: s.title, secondaryText1: s.artist, secondaryText2: s.album, secondaryText3: s.duration, primaryLink: { deeplink: `/albums/B0X?trackAsin=B0T${i}` } }; });
      return { ok: true, captures: [{ body: JSON.stringify({ rows }) }] };
    }
    return { ok: false, error: "Unknown action" };
  }

  const tabs = [];
  if (sc.yt !== "missing") tabs.push({ id: 1, url: "https://music.youtube.com/", title: "YouTube Music", lastAccessed: 5, status: "complete", windowId: 1 });
  if (sc.jiosaavn !== "missing") tabs.push({ id: 2, url: "https://www.jiosaavn.com/", title: "JioSaavn", lastAccessed: 4, status: "complete", windowId: 1 });
  if (sc.amazon !== "missing") tabs.push({ id: 3, url: "https://music.amazon.in/user-playlists/abc", title: "Gym Mix | Amazon Music", lastAccessed: 3, status: "complete", windowId: 1 });

  window.chrome = {
    tabs: {
      query: async (q) => {
        const urls = q && q.url ? [].concat(q.url).join(" ") : "";
        return tabs.filter((t) => !urls || (urls.includes("youtube") && t.url.includes("youtube")) || (urls.includes("jiosaavn") && t.url.includes("jiosaavn")));
      },
      sendMessage: async (id, msg) => {
        if (id === 1 && sc.yt === "frozen") return new Promise(() => {}); // a hung tab never answers
        if (id === 1 && sc.yt === "reload") throw new Error("Could not establish connection. Receiving end does not exist.");
        if (id === 1) return ytAction(msg.action, msg.args || []);
        if (id === 2) return jsAction(msg.action, msg.args || []);
        return amzAction(msg.action);
      },
      create: async (o) => { window.__calls.push(["tabs.create", o.url]); return { id: 99 }; },
      update: async () => ({}),
      reload: async () => { window.__calls.push(["tabs.reload"]); },
    },
    windows: { update: async () => ({}) },
  };
})();
