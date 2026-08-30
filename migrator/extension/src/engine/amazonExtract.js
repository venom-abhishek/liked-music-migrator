// Amazon Music extraction via response interception (see
// migrator/PHASE3_AMAZON_DISCOVERY.md for why: forging a request was
// abandoned as unworkable — Amazon's "Skyfire" API validates against
// server-side session state built by a preceding call sequence, not just
// per-request auth fields). Instead: auto-scroll the page the operator is
// already looking at, and let the page make its own real, already-
// authenticated calls, then read what comes back.
//
// The response is Amazon's own templated-UI ("Skyfire") tree, not plain
// song data — recursively find the row-item nodes inside it. Field mapping
// below (secondaryText1/2/3 = artist/album/duration, track id in the
// deeplink's trackAsin param rather than the row's own `id`) is confirmed
// against a real captured showLibraryPlaylist response, not guessed.

import { decodeHtmlEntities, detectVersionTag } from "./normalize.js";

const ROW_ITEM_INTERFACE = /VisualRowItemElement|VisualTwoLine\w*ListItem|ListItemElement/i;

function parseDuration(text) {
  if (!text || !/^\d+:\d+(:\d+)?$/.test(text.trim())) return null;
  const parts = text.trim().split(":").map((p) => parseInt(p, 10));
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds;
}

function trackAsinFromDeeplink(deeplink) {
  if (!deeplink) return null;
  const m = /[?&]trackAsin=([A-Z0-9]+)/.exec(deeplink);
  return m ? m[1] : null;
}

function albumAsinFromDeeplink(deeplink) {
  if (!deeplink) return null;
  const m = /\/albums\/([A-Z0-9]+)/.exec(deeplink);
  return m ? m[1] : null;
}

function findRowItems(node, out, seen, depth = 0) {
  if (!node || typeof node !== "object" || depth > 25) return;
  if (Array.isArray(node)) {
    for (const item of node) findRowItems(item, out, seen, depth + 1);
    return;
  }
  const iface = node.interface || "";
  if (ROW_ITEM_INTERFACE.test(iface) && node.primaryText && node.primaryLink) {
    const trackAsin = trackAsinFromDeeplink(node.primaryLink.deeplink);
    if (trackAsin && !seen.has(trackAsin)) {
      seen.add(trackAsin);
      out.push({ ...node, __trackAsin: trackAsin });
    }
  }
  for (const key of Object.keys(node)) {
    findRowItems(node[key], out, seen, depth + 1);
  }
}

function parseCapturedBody(bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (_e) {
    return [];
  }
  const items = [];
  findRowItems(json, items, new Set());
  return items.map((item) => {
    const title = decodeHtmlEntities(item.primaryText || "");
    return {
      trackAsin: item.__trackAsin,
      title,
      artists: decodeHtmlEntities(item.secondaryText1 || ""),
      album: decodeHtmlEntities(item.secondaryText2 || ""),
      duration_sec: parseDuration(item.secondaryText3),
      albumAsin: albumAsinFromDeeplink(item.primaryLink && item.primaryLink.deeplink),
      version_tag: detectVersionTag(title),
    };
  });
}

/** Scrolls the page in steps, capturing Skyfire API responses, until content stops growing. */
export async function autoScrollAndCapture(client, opts = {}) {
  const { maxSteps = 80, stableStop = 3, pxPerStep = 1600, waitMs = 900, onProgress } = opts;
  await client.clearCaptures();
  await client.startCapture();
  let stableCount = 0;
  for (let i = 0; i < maxSteps; i++) {
    onProgress?.(`Scrolling (${i + 1}/${maxSteps})…`);
    const { scrollHeightBefore, scrollHeightAfter, atBottom } = await client.scrollStep(pxPerStep, waitMs);
    if (scrollHeightAfter <= scrollHeightBefore) {
      stableCount++;
      if (stableCount >= stableStop || atBottom) break;
    } else {
      stableCount = 0;
    }
  }
  await client.stopCapture();
  return client.getCaptures();
}

/** De-dupes captured responses by track ASIN and converts to Song-shape objects. */
export function extractSongsFromCaptures(captures, collectionType, collectionName) {
  const byAsin = new Map();
  for (const cap of captures) {
    for (const item of parseCapturedBody(cap.body)) {
      if (!byAsin.has(item.trackAsin)) byAsin.set(item.trackAsin, item);
    }
  }
  return [...byAsin.values()].map((item) => ({
    source: "amazon",
    collection_type: collectionType,
    collection_name: collectionName,
    source_id: item.trackAsin,
    title: item.title,
    artists: item.artists,
    album: item.album,
    duration_sec: item.duration_sec,
    version_tag: item.version_tag,
  }));
}
