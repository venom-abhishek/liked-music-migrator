// This page has chrome.* extension APIs but no access to music.youtube.com's
// page context. It talks to bridge.js (a content script on the YT Music tab)
// via chrome.tabs.sendMessage; bridge.js relays into inject.js (MAIN world),
// which is the only place that ever touches the auth cookie/hash.

const UI_REQUEST_SOURCE = "ytm-ext-ui-request";

async function findYtMusicTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  return tabs[0] || null;
}

async function callYtMusic(tabId, action, args = []) {
  return chrome.tabs.sendMessage(tabId, { source: UI_REQUEST_SOURCE, action, args });
}

function collectVideoIds(node, set = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 40) return set;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoIds(item, set, depth + 1);
    return set;
  }
  if (typeof node.videoId === "string") set.add(node.videoId);
  for (const key of Object.keys(node)) collectVideoIds(node[key], set, depth + 1);
  return set;
}

const tabStatusEl = document.getElementById("tab-status");
const readLikedResultEl = document.getElementById("read-liked-result");
const likeUnlikeResultEl = document.getElementById("like-unlike-result");
const videoIdInput = document.getElementById("video-id");

let currentTab = null;

async function refreshTabStatus() {
  tabStatusEl.textContent = "Checking…";
  tabStatusEl.className = "status";
  currentTab = await findYtMusicTab();
  if (!currentTab) {
    tabStatusEl.textContent =
      "No open music.youtube.com tab found. Open one, log in, and click Re-check.";
    tabStatusEl.className = "status err";
    return;
  }
  tabStatusEl.textContent = `Found tab: ${currentTab.url} (tab id ${currentTab.id})`;
  tabStatusEl.className = "status ok";
}

document.getElementById("refresh-tab").addEventListener("click", refreshTabStatus);

document.getElementById("read-liked").addEventListener("click", async () => {
  readLikedResultEl.textContent = "Calling browse (VLLM)…";
  if (!currentTab) await refreshTabStatus();
  if (!currentTab) {
    readLikedResultEl.textContent = "No YT Music tab available.";
    return;
  }
  try {
    const resp = await callYtMusic(currentTab.id, "browseLikedSongs");
    if (!resp.ok) {
      readLikedResultEl.textContent = `Error: ${resp.error}`;
      return;
    }
    const { status, ok, data } = resp.result;
    const videoIds = data ? collectVideoIds(data) : new Set();
    readLikedResultEl.textContent =
      `HTTP ${status} (${ok ? "ok" : "NOT ok"})\n` +
      `Unique videoIds found in response: ${videoIds.size}\n` +
      `(This is a raw scan for proof-of-read only — exhaustive paging and\n` +
      ` de-duplication is implemented properly in the Phase 1 manager.)`;
  } catch (err) {
    readLikedResultEl.textContent = `Error: ${err.message || err}`;
  }
});

document.getElementById("like-unlike").addEventListener("click", async () => {
  const videoId = videoIdInput.value.trim();
  if (!videoId) {
    likeUnlikeResultEl.textContent = "Enter a videoId first.";
    return;
  }
  if (!currentTab) await refreshTabStatus();
  if (!currentTab) {
    likeUnlikeResultEl.textContent = "No YT Music tab available.";
    return;
  }

  likeUnlikeResultEl.textContent = `Liking ${videoId}…`;
  try {
    const likeResp = await callYtMusic(currentTab.id, "likeSong", [videoId]);
    if (!likeResp.ok) {
      likeUnlikeResultEl.textContent = `Like failed: ${likeResp.error}`;
      return;
    }
    const likeLine = `like/like -> HTTP ${likeResp.result.status} (${likeResp.result.ok ? "ok" : "NOT ok"})`;
    likeUnlikeResultEl.textContent = `${likeLine}\nUn-liking ${videoId}…`;

    const unlikeResp = await callYtMusic(currentTab.id, "removeLikeSong", [videoId]);
    if (!unlikeResp.ok) {
      likeUnlikeResultEl.textContent = `${likeLine}\nUn-like failed: ${unlikeResp.error}`;
      return;
    }
    const unlikeLine = `like/removelike -> HTTP ${unlikeResp.result.status} (${unlikeResp.result.ok ? "ok" : "NOT ok"})`;
    likeUnlikeResultEl.textContent = `${likeLine}\n${unlikeLine}`;
  } catch (err) {
    likeUnlikeResultEl.textContent = `Error: ${err.message || err}`;
  }
});

refreshTabStatus();
