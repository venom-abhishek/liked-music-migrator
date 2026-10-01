// "My music": the YouTube Music manager. Pick a playlist (or Liked songs),
// find songs, select them, then move / remove / un-like — each with a plain
// confirmation, an Undo button in the confirmation toast, and a History
// entry.
//
// The destructive actions write their action-log record BEFORE the first
// API call and flag each track's step as it succeeds (see storage/log.js), so
// a failure or a closed tab partway through still leaves an accurate,
// undoable record.

import { makeYtMusicClient } from "../ytmusic/client.js";
import { fetchAllTracks, fetchAllLibraryPlaylists, CollectionState } from "../engine/reconcile.js";
import { parsePlaylistHeaderMeta, playlistIdToBrowseId } from "../ytmusic/parsers.js";
import { startAction, saveAction, finishAction, performUndo, ACTION_TYPES } from "../storage/log.js";
import { VirtualList } from "./virtual-list.js";
import { h, icon, button, mount, spinner, plural, sleep, downloadText, toCsv } from "./dom.js";
import { confirmDialog, openDialog, errorDialog, toast } from "./dialogs.js";
import { connectionCard } from "./connection.js";

const client = makeYtMusicClient();
const LIKED_ID = "LM";
const LIKED_BROWSE_ID = "VLLM";

const SORTS = {
  order: { label: "Playlist order", field: "_fetchIndex", dir: 1 },
  reverse: { label: "Playlist order (reversed)", field: "_fetchIndex", dir: -1 },
  title: { label: "Song name (A–Z)", field: "title", dir: 1 },
  artist: { label: "Artist (A–Z)", field: "artistsDisplay", dir: 1 },
  album: { label: "Album (A–Z)", field: "album", dir: 1 },
  shortest: { label: "Shortest first", field: "duration_seconds", dir: 1 },
  longest: { label: "Longest first", field: "duration_seconds", dir: -1 },
};

let root = null;
let collections = null; // [{ kind, id, browseId, title, count }]
let current = null; // collection being viewed
let state = null; // CollectionState
let selection = new Set(); // row keys
let filterText = "";
let sortKey = "order";
let visible = [];
let vlist = null;
let lastClickedIndex = null;
let els = {};

export function initLibrary(container) {
  root = container;
}

/** Called whenever the "My music" tab is shown. */
export function showLibrary({ refresh = false } = {}) {
  if (current && !refresh) return renderDetailShell();
  if (!collections || refresh) return loadCollections();
  renderCollections();
}

/** Open a specific collection directly (used by the importer's "see them" link). */
export async function openCollectionByTitle(title) {
  if (!collections) await loadCollections();
  const c = collections && collections.find((x) => x.title === title);
  if (c) openCollection(c);
}

export function invalidateLibrary() {
  collections = null;
  current = null;
}

function rowKey(t) {
  return t.setVideoId || t.videoId;
}

// ---- Collections (playlist cards) ----

let loadGen = 0; // only the newest load may update the screen (an older one can still be waiting on a stuck tab)

async function loadCollections() {
  const gen = ++loadGen;
  current = null;
  // Load again by itself once a problem shown on the card gets fixed (not on
  // the card's first "ok", which would just duplicate the load below).
  let sawProblem = false;
  const conn = connectionCard("youtube", {
    compact: true,
    onChange: (s) => {
      if (s !== "ok") sawProblem = true;
      else if (sawProblem && gen === loadGen) loadCollections();
    },
  });
  mount(root, pageHeader("My music", "Pick a playlist to tidy up. You can move, remove or un-like songs — and undo anything."), conn, spinner("Loading your playlists…"));
  try {
    const likedResponse = await client.browse(LIKED_BROWSE_ID);
    const likedMeta = parsePlaylistHeaderMeta(likedResponse);
    const liked = { kind: "liked", id: LIKED_ID, browseId: LIKED_BROWSE_ID, title: "Liked songs", count: likedMeta.trackCount };
    const playlists = (await fetchAllLibraryPlaylists(client)).map((p) => ({
      kind: "playlist",
      id: p.playlistId,
      browseId: playlistIdToBrowseId(p.playlistId),
      title: p.title,
      count: p.count,
    }));
    if (gen !== loadGen) return;
    collections = [liked, ...playlists];
    conn.stop();
    renderCollections();
  } catch (err) {
    if (gen !== loadGen) return;
    // The connection card above already explains the most common causes
    // (tab not open / not signed in / needs reload) with a fix button, and
    // reloads this list by itself once it turns green.
    mount(
      root,
      pageHeader("My music", "Pick a playlist to tidy up. You can move, remove or un-like songs — and undo anything."),
      conn,
      emptyState("alert", "Couldn't load your playlists yet", "Fix the problem shown above, then press Try again.", button("Try again", { kind: "primary", iconName: "refresh", onClick: () => loadCollections() }))
    );
  }
}

function renderCollections() {
  current = null;
  const cards = collections.map((c) =>
    h(
      "button",
      { class: `playlist-card${c.kind === "liked" ? " liked" : ""}`, onclick: () => openCollection(c) },
      h("div", { class: "playlist-art" }, icon(c.kind === "liked" ? "heart" : "music")),
      h("div", { class: "playlist-info" }, h("strong", { class: "playlist-name" }, c.title), h("span", { class: "muted" }, c.count == null ? "Songs" : plural(c.count, "song"))),
      icon("forward", "chev")
    )
  );
  mount(
    root,
    pageHeader(
      "My music",
      "Pick a playlist to tidy up. You can move, remove or un-like songs — and undo anything.",
      button("Refresh", { kind: "ghost", iconName: "refresh", onClick: () => loadCollections() })
    ),
    collections.length > 1 ? null : h("p", { class: "muted" }, "You don't have any playlists yet — only Liked songs."),
    h("div", { class: "playlist-grid" }, cards)
  );
}

// ---- One collection ----

async function openCollection(collection) {
  current = collection;
  selection = new Set();
  filterText = "";
  sortKey = "order";
  lastClickedIndex = null;
  state = null;
  vlist = null;
  renderDetailShell();
  await loadTracks();
}

async function loadTracks() {
  mount(els.listArea, spinner(`Loading songs from "${current.title}"…`));
  els.count.textContent = "";
  try {
    const tracks = await fetchAllTracks(client, current.browseId);
    state = new CollectionState(current.browseId, tracks);
    current.count = tracks.length;
    renderList();
  } catch (err) {
    mount(els.listArea, emptyState("alert", "Couldn't load these songs", "Check that YouTube Music is open and you're signed in, then try again.", button("Try again", { kind: "primary", iconName: "refresh", onClick: loadTracks })));
  }
}

function renderDetailShell() {
  const isLiked = current.kind === "liked";
  const search = h("input", {
    type: "search",
    class: "input search-input",
    placeholder: isLiked ? "Search your liked songs" : "Search this playlist",
    value: filterText,
    oninput: (e) => {
      filterText = e.target.value;
      renderList();
    },
  });
  const sort = h(
    "select",
    { class: "input select", "aria-label": "Sort songs", onchange: (e) => ((sortKey = e.target.value), renderList()) },
    Object.entries(SORTS).map(([k, s]) => h("option", { value: k, selected: k === sortKey }, `Sort: ${s.label}`))
  );
  els.count = h("span", { class: "muted" });
  els.selectAll = h("input", { type: "checkbox", class: "check", "aria-label": "Select all songs shown", onchange: toggleAllVisible });
  els.selectAllLabel = h("span", {}, "Select all");
  els.listArea = h("div", { class: "track-area" });
  els.actionBar = h("div", { class: "action-bar", hidden: true });

  mount(
    root,
    h(
      "div",
      { class: "detail-head" },
      button("All playlists", { kind: "ghost", iconName: "back", onClick: () => (current = null, renderCollections()) }),
      h(
        "div",
        { class: "detail-title" },
        h("div", { class: `playlist-art small${isLiked ? " liked" : ""}` }, icon(isLiked ? "heart" : "music")),
        h("div", {}, h("h1", {}, current.title), els.count)
      ),
      h(
        "div",
        { class: "detail-tools" },
        button("Save a copy", { kind: "ghost", iconName: "save", title: "Download this list as a spreadsheet file (CSV) — a backup you can keep", onClick: exportCsv }),
        button("Reload", { kind: "ghost", iconName: "refresh", title: "Get the latest from YouTube Music", onClick: loadTracks })
      )
    ),
    h("div", { class: "list-tools" }, h("div", { class: "search-wrap" }, icon("search"), search), sort),
    h("label", { class: "select-all-row" }, els.selectAll, els.selectAllLabel),
    els.listArea,
    els.actionBar
  );
  if (state) renderList();
}

function computeVisible() {
  let tracks = state.tracks;
  const q = filterText.trim().toLowerCase();
  if (q) {
    tracks = tracks.filter(
      (t) => (t.title || "").toLowerCase().includes(q) || (t.artistsDisplay || "").toLowerCase().includes(q) || (t.album || "").toLowerCase().includes(q)
    );
  }
  const { field, dir } = SORTS[sortKey];
  return [...tracks].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av == null || av === "") return bv == null || bv === "" ? 0 : 1;
    if (bv == null || bv === "") return -1;
    if (typeof av === "string") return av.localeCompare(bv, undefined, { sensitivity: "base" }) * dir;
    return (av - bv) * dir;
  });
}

function renderList() {
  if (!state || !els.listArea) return;
  visible = computeVisible();
  els.count.textContent = filterText.trim() ? `${plural(visible.length, "song")} match · ${plural(state.tracks.length, "song")} in total` : plural(state.tracks.length, "song");
  if (state.tracks.length === 0) {
    vlist = null;
    mount(els.listArea, emptyState("music", "This playlist is empty", "There are no songs here yet."));
  } else if (visible.length === 0) {
    vlist = null;
    mount(els.listArea, emptyState("search", "No songs match your search", `Nothing matches "${filterText.trim()}".`, button("Clear search", { kind: "secondary", onClick: clearSearch })));
  } else {
    if (!vlist || !els.listArea.contains(vlist.viewport)) {
      els.listArea.replaceChildren();
      const listEl = h("div", { class: "track-list", role: "list" });
      els.listArea.append(listEl);
      vlist = new VirtualList(listEl, { rowHeight: 60, renderRow });
    }
    vlist.setItems(visible);
  }
  updateSelectionUI();
}

function clearSearch() {
  filterText = "";
  const input = root.querySelector(".search-input");
  if (input) input.value = "";
  renderList();
}

function renderRow(track, index) {
  const key = rowKey(track);
  const selected = selection.has(key);
  const row = h(
    "div",
    { class: `track-row${selected ? " selected" : ""}${track.isAvailable === false ? " unavailable" : ""}`, role: "listitem" },
    h("input", { type: "checkbox", class: "check", checked: selected, "aria-label": `Select ${track.title}`, tabindex: "0" }),
    h(
      "div",
      { class: "track-main" },
      h("div", { class: "track-title" }, track.title, track.isAvailable === false ? h("span", { class: "chip" }, "Unavailable") : null),
      h("div", { class: "track-artist muted" }, track.artistsDisplay || "Unknown artist")
    ),
    h("div", { class: "track-album muted" }, track.album || ""),
    h("div", { class: "track-duration muted" }, track.duration || "")
  );
  // The whole row is the click target; shift-click selects a range.
  row.addEventListener("click", (e) => {
    const shouldSelect = !selection.has(key);
    if (e.shiftKey && lastClickedIndex != null) {
      const [a, b] = [Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index)];
      for (let i = a; i <= b; i++) {
        if (shouldSelect) selection.add(rowKey(visible[i]));
        else selection.delete(rowKey(visible[i]));
      }
    } else if (shouldSelect) selection.add(key);
    else selection.delete(key);
    lastClickedIndex = index;
    if (e.target.tagName !== "INPUT" || e.shiftKey) e.preventDefault();
    vlist.refresh();
    updateSelectionUI();
  });
  return row;
}

function toggleAllVisible(e) {
  if (e.target.checked) visible.forEach((t) => selection.add(rowKey(t)));
  else visible.forEach((t) => selection.delete(rowKey(t)));
  if (vlist) vlist.refresh();
  updateSelectionUI();
}

function selectedTracks() {
  return state ? state.tracks.filter((t) => selection.has(rowKey(t))) : [];
}

function updateSelectionUI() {
  const n = selection.size;
  const visibleSelected = visible.filter((t) => selection.has(rowKey(t))).length;
  els.selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
  els.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  els.selectAllLabel.textContent = filterText.trim() ? `Select all ${plural(visible.length, "match", "matches")}` : `Select all ${plural(visible.length, "song")}`;

  if (n === 0) {
    els.actionBar.hidden = true;
    return;
  }
  const hidden = n - visibleSelected;
  const isLiked = current.kind === "liked";
  mount(
    els.actionBar,
    h(
      "div",
      { class: "action-bar-text" },
      h("strong", {}, `${plural(n, "song")} selected`),
      hidden ? h("span", { class: "muted" }, ` (${hidden} hidden by your search)`) : null
    ),
    h(
      "div",
      { class: "action-bar-buttons" },
      button("Move to…", { kind: "primary", iconName: "move", onClick: () => run(doMove) }),
      isLiked
        ? button("Un-like", { kind: "danger", iconName: "heart", onClick: () => run(doUnlike) })
        : button("Remove from playlist", { kind: "danger", iconName: "trash", onClick: () => run(doRemove) }),
      button("Clear", { kind: "ghost", iconName: "x", onClick: () => (selection.clear(), vlist && vlist.refresh(), updateSelectionUI()) })
    )
  );
  els.actionBar.hidden = false;
}

let running = false;
async function run(fn) {
  if (running) return;
  running = true;
  els.actionBar.classList.add("busy");
  els.actionBar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    await errorDialog(err);
  } finally {
    running = false;
    if (els.actionBar) {
      els.actionBar.classList.remove("busy");
      els.actionBar.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
}

function setBusy(text) {
  mount(els.actionBar, h("div", { class: "action-bar-text" }, h("div", { class: "spinner small" }), h("strong", {}, text)));
  els.actionBar.hidden = false;
}

function toLogTrack(t) {
  return { videoId: t.videoId, setVideoId: t.setVideoId || null, title: t.title, artistsDisplay: t.artistsDisplay, album: t.album };
}

function songList(tracks) {
  const shown = tracks.slice(0, 5);
  return h(
    "ul",
    { class: "mini-list" },
    shown.map((t) => h("li", {}, h("strong", {}, t.title), " — ", t.artistsDisplay || "Unknown artist")),
    tracks.length > shown.length ? h("li", { class: "muted" }, `…and ${tracks.length - shown.length} more`) : null
  );
}

function offerUndo(message, record) {
  toast(message, {
    tone: "success",
    duration: 12000,
    action: {
      label: "Undo",
      iconName: "undo",
      onClick: async () => {
        try {
          await performUndo(client, record);
          toast("Done — that's been undone.", { tone: "success" });
          await sleep(1200); // YouTube Music takes a moment before a re-read shows the change
          if (current) await loadTracks();
        } catch (err) {
          errorDialog(err, { title: "Couldn't undo" });
        }
      },
    },
  });
}

async function doRemove() {
  const tracks = selectedTracks();
  if (!tracks.length) return;
  const ok = await confirmDialog({
    title: `Remove ${plural(tracks.length, "song")} from "${current.title}"?`,
    message: "They'll only be taken out of this playlist — they stay on YouTube Music and in your other playlists.\n\nChanged your mind later? You can undo this from History.",
    details: songList(tracks),
    confirmText: `Remove ${plural(tracks.length, "song")}`,
    danger: true,
  });
  if (!ok) return;
  setBusy(`Removing ${plural(tracks.length, "song")}…`);

  const items = tracks.map((t) => ({ videoId: t.videoId, setVideoId: t.setVideoId }));
  const record = await startAction(
    ACTION_TYPES.REMOVE,
    { kind: current.kind, id: current.id, title: current.title },
    null,
    tracks.map((t) => ({ ...toLogTrack(t), removed: false }))
  );
  try {
    await client.removePlaylistItems(current.id, items);
  } catch (err) {
    await finishAction(record, err);
    updateSelectionUI();
    throw err;
  }
  record.tracks.forEach((t) => (t.removed = true));
  await finishAction(record);
  state.applyLocalRemove(items.map((i) => i.setVideoId));
  current.count = state.tracks.length;
  selection.clear();
  renderList();
  offerUndo(`Removed ${plural(tracks.length, "song")} from "${current.title}".`, record);
}

async function doUnlike() {
  const tracks = selectedTracks();
  if (!tracks.length) return;
  const ok = await confirmDialog({
    title: `Un-like ${plural(tracks.length, "song")}?`,
    message: "They'll be taken out of your Liked songs. The songs stay on YouTube Music and in any playlists they're in.\n\nChanged your mind later? You can undo this from History.",
    details: songList(tracks),
    confirmText: `Un-like ${plural(tracks.length, "song")}`,
    danger: true,
  });
  if (!ok) return;

  const record = await startAction(
    ACTION_TYPES.UNLIKE,
    { kind: "liked", id: LIKED_ID, title: "Liked songs" },
    null,
    tracks.map((t) => ({ ...toLogTrack(t), unliked: false }))
  );
  const done = [];
  try {
    for (let i = 0; i < tracks.length; i++) {
      setBusy(`Un-liking ${i + 1} of ${tracks.length}…`);
      await client.removeLikeSong(tracks[i].videoId);
      record.tracks[i].unliked = true;
      done.push(tracks[i].videoId);
      await saveAction(record);
      await sleep(150);
    }
    await finishAction(record);
  } catch (err) {
    await finishAction(record, err);
    throw new Error(`Un-liked ${done.length} of ${tracks.length} before an error: ${err.message || err}. The ones that were un-liked are listed in History, where you can undo them.`);
  } finally {
    state.applyLocalUnlike(done);
    current.count = state.tracks.length;
    selection.clear();
    renderList();
  }
  offerUndo(`Un-liked ${plural(tracks.length, "song")}.`, record);
}

/** Destination picker. Resolves { kind, id, title } or { newName } or null. */
async function pickDestination(tracks) {
  const targets = collections.filter((c) => !(c.kind === current.kind && c.id === current.id));
  let choice = null;
  const newName = h("input", { type: "text", class: "input", placeholder: "Name for the new playlist", "aria-label": "New playlist name" });
  const filter = h("input", { type: "search", class: "input", placeholder: "Find a playlist", "aria-label": "Find a playlist" });
  const list = h("div", { class: "pick-list", role: "radiogroup" });
  const confirmBtn = button("Move here", { kind: "primary", iconName: "move", disabled: true });

  function option(value, label, sub, iconName) {
    const input = h("input", { type: "radio", name: "dest", value, class: "radio" });
    const el = h("label", { class: "pick-option" }, input, h("div", { class: "playlist-art tiny" }, icon(iconName)), h("div", {}, h("strong", {}, label), sub ? h("div", { class: "muted small" }, sub) : null));
    input.addEventListener("change", () => {
      choice = value;
      newName.parentElement.hidden = value !== "new";
      if (value === "new") newName.focus();
      update();
    });
    return el;
  }
  function renderOptions() {
    const q = filter.value.trim().toLowerCase();
    mount(
      list,
      option("new", "A new playlist", "Make a fresh playlist for these songs", "plus"),
      targets
        .filter((c) => !q || c.title.toLowerCase().includes(q))
        .map((c) => option(`${c.kind}:${c.id}`, c.title, c.count == null ? null : plural(c.count, "song"), c.kind === "liked" ? "heart" : "music"))
    );
  }
  function update() {
    confirmBtn.disabled = !choice || (choice === "new" && !newName.value.trim());
  }
  filter.addEventListener("input", renderOptions);
  newName.addEventListener("input", update);
  renderOptions();

  const result = await openDialog({
    title: `Move ${plural(tracks.length, "song")} to…`,
    iconName: "move",
    wide: true,
    body: (close) => {
      confirmBtn.addEventListener("click", () => close("go"));
      newName.addEventListener("keydown", (e) => e.key === "Enter" && !confirmBtn.disabled && close("go"));
      return h(
        "div",
        {},
        current.kind === "liked"
          ? h("p", { class: "note" }, icon("help"), "Moving songs out of Liked songs also un-likes them. To keep them liked, they'll need to be liked again.")
          : null,
        targets.length > 6 ? filter : null,
        list,
        h("div", { class: "new-name", hidden: true }, newName),
        h("div", { class: "dialog-actions inline" }, button("Cancel", { kind: "ghost", onClick: () => close(null) }), confirmBtn)
      );
    },
  });
  if (result !== "go") return null;
  if (choice === "new") return { newName: newName.value.trim() };
  const [kind, id] = choice.split(/:(.+)/);
  const c = collections.find((x) => x.kind === kind && x.id === id);
  return { kind: c.kind, id: c.id, title: c.title };
}

async function doMove() {
  const tracks = selectedTracks();
  if (!tracks.length) return;
  const picked = await pickDestination(tracks);
  if (!picked) return;
  const destination = picked.newName ? { kind: "playlist", id: null, title: picked.newName } : picked;
  setBusy("Getting ready…");

  // What's already in the destination: those tracks are only removed from
  // the source, not added again (YT Music refuses a playlist add that would
  // duplicate a track, and re-liking an already-liked song would make undo
  // wrongly un-like it).
  let alreadyInDest = new Set();
  if (destination.id) {
    const browseId = destination.kind === "liked" ? LIKED_BROWSE_ID : playlistIdToBrowseId(destination.id);
    alreadyInDest = new Set((await fetchAllTracks(client, browseId)).map((t) => t.videoId));
  }

  const record = await startAction(
    ACTION_TYPES.MOVE,
    { kind: current.kind, id: current.id, title: current.title },
    destination,
    tracks.map((t) => ({ ...toLogTrack(t), addedToDest: false, destSetVideoId: null, removedFromSource: false }))
  );

  const removedKeys = [];
  let added = 0;
  try {
    if (picked.newName) {
      setBusy(`Creating "${picked.newName}"…`);
      const playlistId = await client.createPlaylist(picked.newName, "Created by YT Music Manager & Migrator");
      destination.id = playlistId;
      record.createdPlaylistId = playlistId;
      await saveAction(record);
      collections.push({ kind: "playlist", id: playlistId, browseId: playlistIdToBrowseId(playlistId), title: picked.newName, count: 0 });
    }

    // 1. Add to destination (skipping what's already there; a song selected
    //    twice, as two copies in a playlist, is only added once).
    const toAddIdx = [];
    const queued = new Set();
    tracks.forEach((t, i) => {
      if (alreadyInDest.has(t.videoId) || queued.has(t.videoId)) return;
      queued.add(t.videoId);
      toAddIdx.push(i);
    });
    if (destination.kind === "liked") {
      for (let n = 0; n < toAddIdx.length; n++) {
        const i = toAddIdx[n];
        setBusy(`Liking ${n + 1} of ${toAddIdx.length}…`);
        await client.likeSong(tracks[i].videoId);
        record.tracks[i].addedToDest = true;
        await saveAction(record);
        await sleep(150);
      }
    } else if (toAddIdx.length) {
      setBusy(`Adding ${plural(toAddIdx.length, "song")} to "${destination.title}"…`);
      const addResp = await client.addPlaylistItems(destination.id, toAddIdx.map((i) => tracks[i].videoId));
      const destSetVideoIds = {};
      for (const r of (addResp && addResp.playlistEditResults) || []) {
        const data = r && r.playlistEditVideoAddedResultData;
        if (data && data.videoId && data.setVideoId) destSetVideoIds[data.videoId] = data.setVideoId;
      }
      for (const i of toAddIdx) {
        record.tracks[i].addedToDest = true;
        record.tracks[i].destSetVideoId = destSetVideoIds[tracks[i].videoId] || null;
      }
      await saveAction(record);
    }
    added = toAddIdx.length;

    // 2. Only then remove from source — if step 1 failed we never get here,
    //    so a failure can leave a track in two places, never in neither.
    if (current.kind === "liked") {
      for (let i = 0; i < tracks.length; i++) {
        setBusy(`Taking out of Liked songs: ${i + 1} of ${tracks.length}…`);
        await client.removeLikeSong(tracks[i].videoId);
        record.tracks[i].removedFromSource = true;
        removedKeys.push(tracks[i].videoId);
        await saveAction(record);
        await sleep(150);
      }
    } else {
      setBusy(`Taking out of "${current.title}"…`);
      const items = tracks.map((t) => ({ videoId: t.videoId, setVideoId: t.setVideoId }));
      await client.removePlaylistItems(current.id, items);
      record.tracks.forEach((t) => (t.removedFromSource = true));
      removedKeys.push(...items.map((i) => i.setVideoId));
    }
    await finishAction(record);
  } catch (err) {
    await finishAction(record, err);
    throw new Error(`The move stopped partway: ${err.message || err}. Nothing was lost — what did happen is listed in History, where you can undo it.`);
  } finally {
    if (current.kind === "liked") state.applyLocalUnlike(removedKeys);
    else state.applyLocalRemove(removedKeys);
    current.count = state.tracks.length;
    const dest = collections.find((c) => c.kind === destination.kind && c.id === destination.id);
    if (dest && dest.count != null) dest.count += added;
    selection.clear();
    renderList();
  }
  const skipped = tracks.length - added;
  offerUndo(
    `Moved ${plural(tracks.length, "song")} to "${destination.title}".` + (skipped ? ` (${skipped} ${skipped === 1 ? "was" : "were"} already there.)` : ""),
    record
  );
}

function exportCsv() {
  if (!state) return;
  const rows = [["Title", "Artist", "Album", "Length", "YouTube Music link"]].concat(
    state.tracks.map((t) => [t.title, t.artistsDisplay, t.album, t.duration || "", `https://music.youtube.com/watch?v=${t.videoId}`])
  );
  const safe = current.title.replace(/[\\/:*?"<>|]+/g, "_");
  downloadText(`${safe} - ${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  toast(`Saved a copy of "${current.title}" to your Downloads folder.`, { tone: "success" });
}

// ---- shared bits ----

export function pageHeader(title, subtitle, ...right) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle ? h("p", { class: "muted lead" }, subtitle) : null), right.length ? h("div", { class: "page-head-actions" }, right) : null);
}

export function emptyState(iconName, title, text, ...actions) {
  return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon(iconName)), h("h3", {}, title), text ? h("p", { class: "muted" }, text) : null, actions.length ? h("div", { class: "empty-actions" }, actions) : null);
}
