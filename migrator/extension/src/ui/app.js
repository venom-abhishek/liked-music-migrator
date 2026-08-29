import { findYtMusicTab, makeYtMusicClient } from "../ytmusic/client.js";
import { fetchAllTracks, fetchAllLibraryPlaylists, CollectionState } from "../engine/reconcile.js";
import { parsePlaylistHeaderMeta, playlistIdToBrowseId } from "../ytmusic/parsers.js";
import { logAction, listActions, performUndo, ACTION_TYPES } from "../storage/log.js";
import { findJioSaavnTab, makeJioSaavnClient } from "../sources/jiosaavnClient.js";
import { getJioSaavnInventory, extractJioSaavnSongs } from "../engine/jiosaavnExtract.js";
import { matchSong, AUTO, REVIEW, NOT_FOUND } from "../engine/matcher.js";
import { commitImport } from "../engine/importer.js";

const LIKED_ID = "LM";
const LIKED_BROWSE_ID = "VLLM";

// Stateless — every call re-resolves the YT Music tab fresh, so this is
// created once and reused for the lifetime of the page. See client.js for
// why it's stateless rather than bound to a tabId captured at load time.
const client = makeYtMusicClient();
const jiosaavnClient = makeJioSaavnClient();

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
const viewImport = el("view-import");
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
  viewImport.hidden = name !== "import";
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
  // Note: deliberately not clearing trackListEl's DOM here. The virtualized
  // list's spacer/viewport elements live inside it; wiping innerHTML detaches
  // them while `vlist` still holds references to the now-orphaned nodes, so
  // every render after the first quietly updates elements nothing displays.
  // Clearing rows through the list's own API (below) keeps it intact.
  if (vlist) vlist.setItems([]);

  try {
    const tracks = await fetchAllTracks(client, collection.browseId);
    collectionState = new CollectionState(collection.browseId, tracks);
    detailTitleEl.textContent = `${collection.title} (${tracks.length})`;
    setupMoveTargets();
    renderTrackList();
  } catch (err) {
    detailTitleEl.textContent = `${collection.title} — failed to load`;
    trackListEl.textContent = String(err.message || err);
    vlist = null; // container's contents were just replaced with plain text; rebuild the list fresh next time
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
    case ACTION_TYPES.IMPORT:
      return `Imported ${action.tracks.length} from JioSaavn into "${action.destination.title}"`;
    default:
      return action.type;
  }
}

// ---- Import (JioSaavn) ----

const jiosaavnStatusEl = el("jiosaavn-status");
const jiosaavnInventoryEl = el("jiosaavn-inventory");
const jiosaavnLikedCountEl = el("jiosaavn-liked-count");
const jiosaavnPlaylistListEl = el("jiosaavn-playlist-list");
const importProgressEl = el("import-progress");
const importPreviewResultsEl = el("import-preview-results");
const importSummaryEl = el("import-summary");
const reviewCountEl = el("review-count");
const reviewListEl = el("review-list");
const notfoundCountEl = el("notfound-count");
const notfoundListEl = el("notfound-list");
const importCommitResultsEl = el("import-commit-results");

let jiosaavnInventory = null;
let previewMatched = []; // [{ song, match }] — every decision, not just AUTO

async function ensureJioSaavnTab() {
  const tab = await findJioSaavnTab();
  if (!tab) {
    jiosaavnStatusEl.textContent = "No open jiosaavn.com tab found. Open one, log in, and click Re-check.";
    jiosaavnStatusEl.className = "status err";
    return false;
  }
  jiosaavnStatusEl.textContent = `Connected: ${tab.url}`;
  jiosaavnStatusEl.className = "status ok";
  return true;
}

async function loadJioSaavnLibrary() {
  if (!(await ensureJioSaavnTab())) return;
  el("jiosaavn-load").disabled = true;
  el("jiosaavn-load").textContent = "Loading…";
  try {
    jiosaavnInventory = await getJioSaavnInventory(jiosaavnClient);
    jiosaavnLikedCountEl.textContent = String(jiosaavnInventory.liked.count);
    jiosaavnPlaylistListEl.innerHTML = "";
    for (const p of jiosaavnInventory.playlists) {
      const label = document.createElement("label");
      label.className = "row-check";
      label.innerHTML = `<input type="checkbox" checked data-playlist="${escapeHtml(p.name)}" /> ${escapeHtml(p.name)} (${p.count})`;
      jiosaavnPlaylistListEl.appendChild(label);
    }
    jiosaavnInventoryEl.hidden = false;
  } catch (err) {
    jiosaavnStatusEl.textContent = `Failed to load: ${err.message || err}`;
    jiosaavnStatusEl.className = "status err";
  } finally {
    el("jiosaavn-load").disabled = false;
    el("jiosaavn-load").textContent = "Load JioSaavn library";
  }
}

function getJioSaavnSelection() {
  const includeLiked = el("jiosaavn-include-liked").checked;
  const checkedNames = new Set(
    [...jiosaavnPlaylistListEl.querySelectorAll("input[data-playlist]:checked")].map((i) => i.dataset.playlist)
  );
  return {
    liked: includeLiked ? jiosaavnInventory.liked : null,
    playlists: jiosaavnInventory.playlists.filter((p) => checkedNames.has(p.name)),
  };
}

function getImportMode() {
  return document.querySelector('input[name="import-mode"]:checked').value;
}

function setProgress(el, text, state) {
  el.textContent = text;
  el.className = state ? `status ${state}` : "status";
}

async function runPreview() {
  if (!jiosaavnInventory) return;
  const selection = getJioSaavnSelection();
  importPreviewResultsEl.hidden = true;
  importCommitResultsEl.hidden = true;
  previewMatched = [];

  const previewBtn = el("import-preview");
  previewBtn.disabled = true;
  setProgress(importProgressEl, "Extracting from JioSaavn…", "busy");
  let extraction;
  try {
    extraction = await extractJioSaavnSongs(jiosaavnClient, selection);
  } catch (err) {
    setProgress(importProgressEl, `Extraction failed: ${err.message || err}`, "err");
    previewBtn.disabled = false;
    return;
  }

  const songs = extraction.songs;
  const counts = { [AUTO]: 0, [REVIEW]: 0, [NOT_FOUND]: 0 };
  for (let i = 0; i < songs.length; i++) {
    setProgress(importProgressEl, `Matching ${i + 1}/${songs.length}: ${songs[i].title}`, "busy");
    let match;
    try {
      match = await matchSong(songs[i], client);
    } catch (err) {
      match = { decision: NOT_FOUND, reason: String(err.message || err) };
    }
    counts[match.decision] = (counts[match.decision] || 0) + 1;
    previewMatched.push({ song: songs[i], match });
  }

  previewBtn.disabled = false;
  const warningText = extraction.warnings.length ? ` (${extraction.warnings.join(" | ")})` : "";
  setProgress(importProgressEl, `Matching complete.${warningText}`, "ok");
  importSummaryEl.textContent =
    `${songs.length} tracks — ${counts[AUTO]} will auto-import, ${counts[REVIEW]} need review, ${counts[NOT_FOUND]} not found.`;
  reviewCountEl.textContent = String(counts[REVIEW]);
  notfoundCountEl.textContent = String(counts[NOT_FOUND]);
  reviewListEl.innerHTML = "";
  notfoundListEl.innerHTML = "";
  for (const { song, match } of previewMatched) {
    if (match.decision === REVIEW) {
      const li = document.createElement("li");
      const cand = match.chosen;
      li.textContent = `${song.title} — ${song.artists}  →  best guess: "${cand.title}" — ${cand.artists} (${cand.combined.toFixed(0)}%)`;
      reviewListEl.appendChild(li);
    } else if (match.decision === NOT_FOUND) {
      const li = document.createElement("li");
      li.textContent = `${song.title} — ${song.artists}`;
      notfoundListEl.appendChild(li);
    }
  }
  importPreviewResultsEl.hidden = false;
}

async function runCommit() {
  const autoMatched = previewMatched.filter((e) => e.match.decision === AUTO);
  importCommitResultsEl.hidden = false;
  if (autoMatched.length === 0) {
    setProgress(importCommitResultsEl, "Nothing to commit — no AUTO matches.", null);
    return;
  }
  const mode = getImportMode();
  const singlePlaylistName = el("single-playlist-name").value.trim() || "JioSaavn Import";
  if (!confirm(`Write ${autoMatched.length} AUTO-matched track(s) to YouTube Music now?`)) return;

  const commitBtn = el("import-commit");
  const previewBtn = el("import-preview");
  commitBtn.disabled = true;
  previewBtn.disabled = true;
  setProgress(importCommitResultsEl, "Loading current YouTube Music state…", "busy");

  try {
    const likedTracks = await fetchAllTracks(client, LIKED_BROWSE_ID);
    const playlists = (await fetchAllLibraryPlaylists(client)).map((p) => ({ id: p.playlistId, title: p.title }));

    const results = await commitImport(client, autoMatched, mode, singlePlaylistName, { likedTracks, playlists }, (text) => {
      setProgress(importCommitResultsEl, text, "busy");
    });

    const summary = { added: 0, already_present: 0, duplicate: 0, error: 0 };
    for (const r of results) summary[r.outcome] = (summary[r.outcome] || 0) + 1;
    setProgress(
      importCommitResultsEl,
      `Done: ${summary.added} added, ${summary.already_present} already present, ` +
        `${summary.duplicate} duplicate, ${summary.error} error(s).`,
      summary.error > 0 ? "err" : "ok"
    );
  } catch (err) {
    setProgress(
      importCommitResultsEl,
      `Commit failed partway through: ${err.message || err}. Check Activity & Undo for whatever ` +
        "did get written before the failure (if anything) — re-running import will skip it as already present.",
      "err"
    );
  } finally {
    commitBtn.disabled = false;
    previewBtn.disabled = false;
  }
}

// ---- Wiring ----

document.querySelectorAll("nav button[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    showView(btn.dataset.view);
    if (btn.dataset.view === "log") renderLogView();
    if (btn.dataset.view === "import") ensureJioSaavnTab();
  });
});

el("jiosaavn-refresh").addEventListener("click", ensureJioSaavnTab);
el("jiosaavn-load").addEventListener("click", () => loadJioSaavnLibrary().catch((e) => alert(e.message || e)));
el("import-preview").addEventListener("click", () => runPreview().catch((e) => alert(e.message || e)));
el("import-commit").addEventListener("click", () => runCommit().catch((e) => alert(e.message || e)));

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
