// Read-after-write reconciliation + page-to-exhaustion helpers (spec §6).
//
// Two real-account findings this module exists to satisfy:
//  1. A `limit` param is not honored precisely and a single fetch is never
//     complete — always page to true exhaustion and de-dup by videoId.
//  2. Immediately after a write, a fresh read of the same collection can be
//     briefly stale. Rather than re-fetching right after writing, the
//     manager UI applies its own writes to its in-memory track list
//     directly (see applyLocalRemove/applyLocalAdd below) and only re-fetches
//     from the network when the user explicitly asks to refresh.

import {
  getPlaylistShelfContentData,
  parsePlaylistItems,
  parseLibraryPlaylists,
  parseLibraryPlaylistsContinuation,
} from "../ytmusic/parsers.js";
import { getContinuationToken, nav, CONTINUATION_ITEMS } from "../ytmusic/navigation.js";

/**
 * Fetches every track in a playlist or Liked Songs collection, paging to
 * exhaustion and de-duplicating overlapping pages (YT Music's continuation
 * cursor can repeat rows).
 *
 * De-dup key is the playlist ENTRY (setVideoId) when there is one, not the
 * song (videoId): a playlist can legitimately hold the same song twice, as
 * two entries with different setVideoIds, and collapsing those would hide
 * the extra copies from the manager (so they could never be seen or removed)
 * and make its counts disagree with YouTube Music's. Liked Songs rows have no
 * setVideoId and a song can only be liked once, so those fall back to videoId.
 */
export async function fetchAllTracks(client, browseId) {
  const first = await client.browse(browseId);
  const contentData = getPlaylistShelfContentData(first);
  const tracks = contentData && contentData.contents ? parsePlaylistItems(contentData.contents) : [];

  let continuationToken = contentData ? getContinuationToken(contentData.contents) : null;
  while (continuationToken) {
    const resp = await client.browseContinuationBody(continuationToken);
    const continuationItems = nav(resp, CONTINUATION_ITEMS, true);
    if (!continuationItems || continuationItems.length === 0) break;
    const page = parsePlaylistItems(continuationItems);
    if (page.length === 0) break;
    tracks.push(...page);
    continuationToken = getContinuationToken(continuationItems);
  }

  const seen = new Set();
  const deduped = [];
  for (const t of tracks) {
    const key = t.setVideoId || t.videoId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  deduped.forEach((t, i) => {
    t._fetchIndex = i; // proxy for "date added" order — see ui code for why
  });
  return deduped;
}

/**
 * Fetches every one of the user's own playlists (not Liked Songs) with
 * title/count, paging to exhaustion. ytmusicapi's get_library_playlists
 * pages this the "old" way: the original body is resent, with the
 * continuation token appended to the URL as ctoken/continuation.
 */
export async function fetchAllLibraryPlaylists(client) {
  const first = await client.browse("FEmusic_liked_playlists");
  let { playlists, continuationToken } = parseLibraryPlaylists(first);

  while (continuationToken) {
    const resp = await client.browseContinuationUrl("FEmusic_liked_playlists", continuationToken);
    const page = parseLibraryPlaylistsContinuation(resp);
    if (page.playlists.length === 0) break;
    playlists = playlists.concat(page.playlists);
    continuationToken = page.continuationToken;
  }

  const seen = new Set();
  return playlists.filter((p) => (seen.has(p.playlistId) ? false : (seen.add(p.playlistId), true)));
}

/**
 * Tracks this session's own recent writes so the UI can apply them
 * optimistically instead of trusting an immediate re-read. Not persisted —
 * this is a short-lived, in-memory reconciliation aid, not the action log.
 */
export class CollectionState {
  constructor(browseId, tracks) {
    this.browseId = browseId;
    this.tracks = tracks;
  }

  applyLocalRemove(setVideoIds) {
    const remove = new Set(setVideoIds.filter(Boolean));
    this.tracks = this.tracks.filter((t) => !remove.has(t.setVideoId));
  }

  applyLocalUnlike(videoIds) {
    const remove = new Set(videoIds);
    this.tracks = this.tracks.filter((t) => !remove.has(t.videoId));
  }

  applyLocalAdd(newTracks) {
    const existing = new Set(this.tracks.map((t) => t.videoId));
    const additions = newTracks.filter((t) => !existing.has(t.videoId));
    additions.forEach((t, i) => {
      t._fetchIndex = this.tracks.length + i;
    });
    this.tracks = this.tracks.concat(additions);
  }
}
