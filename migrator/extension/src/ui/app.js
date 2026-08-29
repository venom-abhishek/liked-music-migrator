import { findYtMusicTab, makeYtMusicClient } from "../ytmusic/client.js";
import { fetchAllTracks, fetchAllLibraryPlaylists, CollectionState } from "../engine/reconcile.js";
import { parsePlaylistHeaderMeta, playlistIdToBrowseId } from "../ytmusic/parsers.js";
import { logAction, listActions, performUndo, ACTION_TYPES } from "../storage/log.js";

const LIKED_ID = "LM";
const LIKED_BROWSE_ID = "VLLM";

// Stateless — every call re-resolves the YT Music tab fresh, so this is
// created once and reused for the lifetime of the page. See client.js for
// why it's stateless rather than bound to a tabId captured at load time.
const client = makeYtMusicClient();

let collections = []; // { kind: 'liked'|'playlist', id, browseId, title, count }
let currentCollection = null;
let collectionState = null; // CollectionState

let selection = new Set(); // row keys: setVideoId || videoId
let filterText = "";
let sortField = "_fetchIndex";
let sortDir = "asc";

// ---- DOM ----
const el = (id) => document.getElementById(id);
const tabStatusEl = el("tab-status");
const viewCollections = el("view-collections");
const viewDetail = el("view-collection-detail");
const viewLog = el("view-log");
const collectionsListEl = el("collections-list");
const detailTitleEl = el("detail-title");
const filterInput = el("filter-input");
const sortSelect = el("sort-select");
const sortDirBtn = el("sort-dir");
const selectionCountEl = el("selection-count");
const trackListEl = el("track-list");
const moveTargetSelect = el("move-target");
const logListEl = el("log-list");

import { VirtualList } from "./virtual-list.js";

let vlist = null;
let visibleTracks = [];

function showView(name) {
  viewCollections.hidden = name !== "collections";
  viewDetail.hidden = name !== "detail";
  viewLog.hidden = name !== "log";
  document.querySelectorAll("nav button[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
}

function setTabStatus(message, isError) {
  tabStatusEl.textContent = message;
  tabStatusEl.className = "status " + (isError ? "err" : "ok");
}

// Purely a status-banner check — actual calls (via `client`) always
// re-resolve the tab themselves, so nothing here needs to be cached.
async function ensureTab() {
  const tab = await findYtMusicTab();
  if (!tab) {
    setTabStatus("No open music.youtube.com tab found. Open one and log in.", true);
    return false;
  }
  setTabStatus(`Connected: ${tab.url}`, false);
  return true;
}

// ---- Collections list ----

async function loadCollections() {
  if (!(await ensureTab())) return;
  collectionsListEl.textContent = "Loading…";
  try {
    const likedResponse = await client.browse(LIKED_BROWSE_ID);
    const likedMeta = parsePlaylistHeaderMeta(likedResponse);
    const liked = {
      kind: "liked",
      id: LIKED_ID,
      browseId: LIKED_BROWSE_ID,
      title: likedMeta.title || "Liked Music",
      count: likedMeta.trackCount,
    };

    const playlists = (await fetchAllLibraryPlaylists(client)).map((p) => ({
      kind: "playlist",
      id: p.playlistId,
      browseId: playlistIdToBrowseId(p.playlistId),
      title: p.title,
      count: p.count,
    }));

    collections = [liked, ...playlists];
    renderCollectionsList();
  } catch (err) {
    collectionsListEl.textContent = `Failed to load library: ${err.message || err}`;
  }
}

function renderCollectionsList() {
  collectionsListEl.innerHTML = "";
  for (const c of collections) {
    const row = document.createElement("div");
    row.className = "collection-row";
    row.innerHTML = `
      <span class="collection-title">${escapeHtml(c.title)}</span>
      <span class="collection-count">${c.count == null ? "?" : c.count} tracks</span>
    `;
    row.addEventListener("click", () => openCollection(c));
    collectionsListEl.appendChild(row);
  }
}

// ---- Collection detail ----

async function openCollection(collection) {
  currentCollection = collection;
  selection = new Set();
  filterText = "";
  filterInput.value = "";
  showView("detail");
  detailTitleEl.textContent = `${collection.title} — loading…`;
  trackListEl.innerHTML = "";

  try {
    const tracks = await fetchAllTracks(client, collection.browseId);
    collectionState = new CollectionState(collection.browseId, tracks);
    detailTitleEl.textContent = `${collection.title} (${tracks.length})`;
    setupMoveTargets();
    renderTrackList();
  } catch (err) {
    detailTitleEl.textContent = `${collection.title} — failed to load`;
    trackListEl.textContent = String(err.message || err);
  }
}

function setupMoveTargets() {
  moveTargetSelect.innerHTML = "";
  for (const c of collections) {
    if (currentCollection && c.id === currentCollection.id && c.kind === currentCollection.kind) continue;
    const opt = document.createElement("option");
    opt.value = `${c.kind}:${c.id}`;
    opt.textContent = c.title;
    moveTargetSelect.appendChild(opt);
  }
  const newOpt = document.createElement("option");
  newOpt.value = "new";
  newOpt.textContent = "+ New playlist…";
  moveTargetSelect.appendChild(newOpt);
}

function rowKey(t) {
  return t.setVideoId || t.videoId;
}

function computeVisibleTracks() {
  let tracks = collectionState.tracks;
  const q = filterText.trim().toLowerCase();
  if (q) {
    tracks = tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artistsDisplay.toLowerCase().includes(q) ||
        (t.album || "").toLowerCase().includes(q)
    );
  }
  const dir = sortDir === "asc" ? 1 : -1;
  tracks = [...tracks].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
  return tracks;
}

function renderTrackList() {
  visibleTracks = computeVisibleTracks();
  if (!vlist) {
    vlist = new VirtualList(trackListEl, { rowHeight: 44, renderRow });
  }
  vlist.setItems(visibleTracks);
  updateSelectionUI();
}

function renderRow(track, _index) {
  const row = document.createElement("div");
  row.className = "track-row";
  const key = rowKey(track);
  row.innerHTML = `
    <input type="checkbox" class="track-check" ${selection.has(key) ? "checked" : ""} />
    <div class="track-main">
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="track-artist">${escapeHtml(track.artistsDisplay)}</div>
    </div>
    <div class="track-album">${escapeHtml(track.album || "")}</div>
    <div class="track-duration">${track.duration || ""}</div>
  `;
  row.querySelector(".track-check").addEventListener("change", (e) => {
    if (e.target.checked) selection.add(key);
    else selection.delete(key);
    updateSelectionUI();
  });
  return row;
}

function updateSelectionUI() {
  selectionCountEl.textContent = `${selection.size} selected`;
  const isLiked = currentCollection && currentCollection.kind === "liked";
  el("action-remove").hidden = isLiked;
  el("action-unlike").hidden = !isLiked;
  const disabled = selection.size === 0;
  el("action-remove").disabled = disabled;
  el("action-unlike").disabled = disabled;
  el("action-move").disabled = disabled;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function selectedTracks() {
  const keys = selection;
  return collectionState.tracks.filter((t) => keys.has(rowKey(t)));
}

// ---- Destructive actions ----

async function doRemove() {
  const tracks = selectedTracks();
  if (tracks.length === 0) return;
  if (!confirm(`Remove ${tracks.length} track(s) from "${currentCollection.title}"?`)) return;

  const items = tracks.map((t) => ({ videoId: t.videoId, setVideoId: t.setVideoId }));
  await client.removePlaylistItems(currentCollection.id, items);
  collectionState.applyLocalRemove(items.map((i) => i.setVideoId));

  await logAction(
    ACTION_TYPES.REMOVE,
    { kind: currentCollection.kind, id: currentCollection.id, title: currentCollection.title },
    null,
    tracks.map(toLogTrack)
  );

  selection.clear();
  renderTrackList();
}

async function doUnlike() {
  const tracks = selectedTracks();
  if (tracks.length === 0) return;
  if (!confirm(`Un-like ${tracks.length} track(s)?`)) return;

  for (const t of tracks) {
    await client.removeLikeSong(t.videoId);
    await sleep(150);
  }
  collectionState.applyLocalUnlike(tracks.map((t) => t.videoId));

  await logAction(
    ACTION_TYPES.UNLIKE,
    { kind: "liked", id: LIKED_ID, title: "Liked Music" },
    null,
    tracks.map(toLogTrack)
  );

  selection.clear();
  renderTrackList();
}

async function doMove() {
  const tracks = selectedTracks();
  if (tracks.length === 0) return;
  const targetValue = moveTargetSelect.value;

  let destination;
  if (targetValue === "new") {
    const name = prompt("New playlist name:");
    if (!name) return;
    const playlistId = await client.createPlaylist(name, "Created by YT Music Manager & Migrator");
    destination = { kind: "playlist", id: playlistId, title: name };
    collections.push({ kind: "playlist", id: playlistId, browseId: playlistIdToBrowseId(playlistId), title: name, count: 0 });
    await logAction(ACTION_TYPES.PLAYLIST_CREATE, null, destination, [], { createdPlaylistId: playlistId });
  } else {
    const [kind, id] = targetValue.split(/:(.+)/);
    const c = collections.find((x) => x.kind === kind && x.id === id);
    destination = { kind: c.kind, id: c.id, title: c.title };
  }

  if (!confirm(`Move ${tracks.length} track(s) to "${destination.title}"?`)) return;

  const videoIds = tracks.map((t) => t.videoId);
  let destSetVideoIds = {};
  if (destination.kind === "liked") {
    for (const videoId of videoIds) {
      await client.likeSong(videoId);
      await sleep(150);
    }
  } else {
    const addResp = await client.addPlaylistItems(destination.id, videoIds);
    const results = (addResp && addResp.playlistEditResults) || [];
    for (const r of results) {
      const data = r && r.playlistEditVideoAddedResultData;
      if (data && data.videoId && data.setVideoId) destSetVideoIds[data.videoId] = data.setVideoId;
    }
  }

  if (currentCollection.kind === "liked") {
    for (const videoId of videoIds) {
      await client.removeLikeSong(videoId);
      await sleep(150);
    }
    collectionState.applyLocalUnlike(videoIds);
  } else {
    const items = tracks.map((t) => ({ videoId: t.videoId, setVideoId: t.setVideoId }));
    await client.removePlaylistItems(currentCollection.id, items);
    collectionState.applyLocalRemove(items.map((i) => i.setVideoId));
  }

  await logAction(
    ACTION_TYPES.MOVE,
    { kind: currentCollection.kind, id: currentCollection.id, title: currentCollection.title },
    destination,
    tracks.map((t) => ({ ...toLogTrack(t), destSetVideoId: destSetVideoIds[t.videoId] || null }))
  );

  selection.clear();
  renderTrackList();
}

function toLogTrack(t) {
  return { videoId: t.videoId, setVideoId: t.setVideoId || null, title: t.title, artistsDisplay: t.artistsDisplay, album: t.album };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Activity log / undo ----

async function renderLogView() {
  const actions = await listActions();
  logListEl.innerHTML = "";
  if (actions.length === 0) {
    logListEl.textContent = "No actions logged yet.";
    return;
  }
  for (const action of actions) {
    const row = document.createElement("div");
    row.className = "log-row";
    const label = describeAction(action);
    row.innerHTML = `
      <div class="log-main">
        <div class="log-label">${escapeHtml(label)}</div>
        <div class="log-meta">${new Date(action.timestamp).toLocaleString()} · ${action.tracks.length} track(s)</div>
      </div>
      <button class="log-undo" ${action.undone ? "disabled" : ""}>${action.undone ? "Undone" : "Undo"}</button>
    `;
    row.querySelector(".log-undo").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Undoing…";
      try {
        await performUndo(client, action);
        renderLogView();
      } catch (err) {
        alert(`Undo failed: ${err.message || err}`);
        e.target.disabled = false;
        e.target.textContent = "Undo";
      }
    });
    logListEl.appendChild(row);
  }
}

function describeAction(action) {
  switch (action.type) {
    case ACTION_TYPES.REMOVE:
      return `Removed ${action.tracks.length} from "${action.source.title}"`;
    case ACTION_TYPES.UNLIKE:
      return `Un-liked ${action.tracks.length} track(s)`;
    case ACTION_TYPES.MOVE:
      return `Moved ${action.tracks.length} from "${action.source.title}" to "${action.destination.title}"`;
    case ACTION_TYPES.PLAYLIST_CREATE:
      return `Created playlist "${action.destination.title}"`;
    default:
      return action.type;
  }
}

// ---- Wiring ----

document.querySelectorAll("nav button[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    showView(btn.dataset.view);
    if (btn.dataset.view === "log") renderLogView();
  });
});

el("refresh-collections").addEventListener("click", loadCollections);
el("back-to-collections").addEventListener("click", () => showView("collections"));
filterInput.addEventListener("input", (e) => {
  filterText = e.target.value;
  renderTrackList();
});
sortSelect.addEventListener("change", (e) => {
  sortField = e.target.value;
  renderTrackList();
});
sortDirBtn.addEventListener("click", () => {
  sortDir = sortDir === "asc" ? "desc" : "asc";
  sortDirBtn.textContent = sortDir === "asc" ? "↓" : "↑";
  renderTrackList();
});
el("select-all").addEventListener("click", () => {
  visibleTracks.forEach((t) => selection.add(rowKey(t)));
  renderTrackList();
});
el("clear-selection").addEventListener("click", () => {
  selection.clear();
  renderTrackList();
});
el("action-remove").addEventListener("click", () => doRemove().catch((e) => alert(e.message || e)));
el("action-unlike").addEventListener("click", () => doUnlike().catch((e) => alert(e.message || e)));
el("action-move").addEventListener("click", () => doMove().catch((e) => alert(e.message || e)));
el("refresh-collection-detail").addEventListener("click", () => openCollection(currentCollection));

loadCollections();
setInterval(ensureTab, 4000); // keeps the status banner accurate; actions themselves always re-resolve the tab regardless
