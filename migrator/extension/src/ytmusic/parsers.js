// Port of the parts of ytmusicapi's parsers/{playlists,songs,library,browsing}.py
// and browse-response navigation needed to render playlists + their tracks.
// Faithful to the real library's field extraction logic (flex-column /
// navigationEndpoint page-type detection), trimmed to what the manager UI
// needs: videoId, title, artists, album, duration, setVideoId, availability.

import {
  nav,
  CONTENT,
  TWO_COLUMN_RENDERER,
  TAB_CONTENT,
  SECTION_LIST_ITEM,
  SECTION,
  RESPONSIVE_HEADER,
  EDITABLE_PLAYLIST_DETAIL_HEADER,
  HEADER,
  SUBTITLE_RUNS,
  MRLIR,
  MTRIR,
  MENU_ITEMS,
  MENU,
  MENU_SERVICE,
  TITLE,
  TITLE_TEXT,
  NAVIGATION_BROWSE_ID,
  THUMBNAIL_RENDERER,
  SUBTITLE2,
  SINGLE_COLUMN,
  SINGLE_COLUMN_TAB,
  SECTION_LIST,
  TAB_1_CONTENT,
  TAB_2_CONTENT,
  ITEM_SECTION,
  GRID,
  findObjectByKey,
} from "./navigation.js";

export function parseDuration(duration) {
  if (!duration || !duration.trim()) return null;
  const parts = duration.trim().split(":");
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
  }
  const multipliers = [1, 60, 3600];
  let seconds = 0;
  const rev = [...parts].reverse();
  for (let i = 0; i < rev.length; i++) {
    seconds += multipliers[i] * parseInt(rev[i], 10);
  }
  return seconds;
}

function getFlexColumnItem(item, index) {
  const col = item.flexColumns && item.flexColumns[index];
  if (!col) return null;
  const renderer = col.musicResponsiveListItemFlexColumnRenderer;
  if (!renderer || !renderer.text || !renderer.text.runs) return null;
  return renderer;
}

function getFixedColumnItem(item, index) {
  const col = item.fixedColumns && item.fixedColumns[index];
  if (!col) return null;
  const renderer = col.musicResponsiveListItemFixedColumnRenderer;
  if (!renderer || !renderer.text) return null;
  return renderer;
}

function getItemText(item, index, runIndex = 0) {
  const col = getFlexColumnItem(item, index);
  if (!col) return null;
  const runs = col.text.runs;
  return runs[runIndex] ? runs[runIndex].text : null;
}

function parseSongArtistsRuns(runs) {
  const artists = [];
  for (let j = 0; j < Math.floor(runs.length / 2) + 1; j++) {
    const run = runs[j * 2];
    if (!run) continue;
    artists.push({ name: run.text, id: nav(run, NAVIGATION_BROWSE_ID, true) });
  }
  return artists;
}

function parseSongArtists(data, index) {
  const flexItem = getFlexColumnItem(data, index);
  if (!flexItem) return [];
  return parseSongArtistsRuns(flexItem.text.runs);
}

function parseSongAlbum(data, index) {
  const flexItem = getFlexColumnItem(data, index);
  if (!flexItem) return null;
  const browseId = nav(flexItem, ["text", "runs", 0, "navigationEndpoint", ...NAVIGATION_BROWSE_ID], true);
  return { name: getItemText(data, index), id: browseId };
}

/** One playlist row (musicResponsiveListItemRenderer) -> a track object, or null (deleted/unparseable). */
export function parsePlaylistItem(data) {
  let videoId = null;
  let setVideoId = null;

  if (data.menu) {
    const menuItems = nav(data, MENU_ITEMS, true) || [];
    for (const item of menuItems) {
      if (item.menuServiceItemRenderer) {
        const menuService = nav(item, MENU_SERVICE, true);
        if (menuService && menuService.playlistEditEndpoint) {
          setVideoId = nav(menuService, ["playlistEditEndpoint", "actions", 0, "setVideoId"], true);
          videoId = nav(menuService, ["playlistEditEndpoint", "actions", 0, "removedVideoId"], true);
        }
      }
    }
  }

  const playButton = nav(data, ["overlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer"], true);
  if (playButton && playButton.playNavigationEndpoint) {
    videoId = nav(playButton, ["playNavigationEndpoint", "watchEndpoint", "videoId"], true) || videoId;
  }

  let isAvailable = true;
  if ("musicItemRendererDisplayPolicy" in data) {
    isAvailable = data.musicItemRendererDisplayPolicy !== "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";
  }

  let titleIndex = null;
  let artistIndex = null;
  let albumIndex = null;
  const userChannelIndexes = [];
  let unrecognizedIndex = null;

  const flexColumns = data.flexColumns || [];
  for (let index = 0; index < flexColumns.length; index++) {
    const flexItem = getFlexColumnItem(data, index);
    const run = flexItem && flexItem.text.runs[0];
    const navEndpoint = run && run.navigationEndpoint;
    if (!navEndpoint) {
      if (run && run.text != null) unrecognizedIndex = unrecognizedIndex ?? index;
      continue;
    }
    if (navEndpoint.watchEndpoint) {
      titleIndex = index;
    } else if (navEndpoint.browseEndpoint) {
      const pageType = nav(
        navEndpoint,
        ["browseEndpoint", "browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig", "pageType"],
        true
      );
      if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || pageType === "MUSIC_PAGE_TYPE_UNKNOWN") {
        artistIndex = index;
      } else if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
        albumIndex = index;
      } else if (pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
        userChannelIndexes.push(index);
      } else if (pageType === "MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE") {
        titleIndex = index;
      }
    }
  }

  if (artistIndex === null && unrecognizedIndex !== null) artistIndex = unrecognizedIndex;
  if (artistIndex === null && userChannelIndexes.length) artistIndex = userChannelIndexes[userChannelIndexes.length - 1];
  // Reasonable fallback for shapes we didn't fully replicate: standard song rows are [title, artist, album].
  if (titleIndex === null) titleIndex = 0;
  if (artistIndex === null) artistIndex = 1;
  if (albumIndex === null) albumIndex = 2;

  const title = getItemText(data, titleIndex);
  if (title === "Song deleted" || !videoId) return null;

  const artists = parseSongArtists(data, artistIndex);
  const album = parseSongAlbum(data, albumIndex);

  let duration = null;
  if (data.fixedColumns) {
    const fixed = getFixedColumnItem(data, 0);
    if (fixed) {
      duration = fixed.text.simpleText || (fixed.text.runs && fixed.text.runs[0] && fixed.text.runs[0].text) || null;
    }
  }

  return {
    videoId,
    setVideoId: setVideoId || null,
    title,
    artists,
    artistsDisplay: artists.map((a) => a.name).join(", "),
    album: album ? album.name : "",
    duration,
    duration_seconds: parseDuration(duration),
    isAvailable,
  };
}

export function parsePlaylistItems(results) {
  const tracks = [];
  for (const result of results) {
    if (!result[MRLIR]) continue;
    const track = parsePlaylistItem(result[MRLIR]);
    if (track) tracks.push(track);
  }
  return tracks;
}

/** Extracts the musicPlaylistShelfRenderer content_data node from a full `browse` response for a playlist/Liked Songs page. */
export function getPlaylistShelfContentData(response) {
  const sectionList = nav(response, [...TWO_COLUMN_RENDERER, "secondaryContents", ...SECTION]);
  return nav(sectionList, [...CONTENT, "musicPlaylistShelfRenderer"]);
}

/** Title + track-count metadata from a playlist/Liked Songs `browse` response header. */
export function parsePlaylistHeaderMeta(response) {
  const headerData = nav(response, [...TWO_COLUMN_RENDERER, ...TAB_CONTENT, ...SECTION_LIST_ITEM]);
  const owned = EDITABLE_PLAYLIST_DETAIL_HEADER[0] in headerData;
  const header = owned
    ? nav(headerData, [...EDITABLE_PLAYLIST_DETAIL_HEADER, ...HEADER, ...RESPONSIVE_HEADER])
    : nav(headerData, RESPONSIVE_HEADER);

  const title = (nav(header, ["title", "runs"], true) || []).map((r) => r.text).join("");
  let trackCount = null;
  const secondSubtitle = header.secondSubtitle;
  if (secondSubtitle && secondSubtitle.runs) {
    const runs = secondSubtitle.runs;
    const hasViews = runs.length > 3 ? 2 : 0;
    const countText = runs[hasViews] ? runs[hasViews].text : "";
    const digits = (countText.match(/\d+/g) || []).join("");
    trackCount = digits ? parseInt(digits, 10) : null;
  }
  return { title, trackCount, owned };
}

/** List of the user's own playlists (not Liked Songs) with title/count, from FEmusic_liked_playlists. */
export function parseLibraryPlaylists(response) {
  let contents = nav(response, [...SINGLE_COLUMN_TAB, ...SECTION_LIST], true);
  let items;
  if (contents == null) {
    const numTabs = nav(response, [...SINGLE_COLUMN, "tabs"]).length;
    const libraryTab = numTabs < 3 ? TAB_1_CONTENT : TAB_2_CONTENT;
    items = nav(response, [...SINGLE_COLUMN, ...libraryTab, ...SECTION_LIST_ITEM, ...GRID], true);
  } else {
    const results = findObjectByKey(contents, "itemSectionRenderer");
    if (results == null) {
      items = nav(response, [...SINGLE_COLUMN_TAB, ...SECTION_LIST_ITEM, ...GRID], true);
    } else {
      items = nav(results, [...ITEM_SECTION, ...GRID], true);
    }
  }
  if (!items || !items.items) return { playlists: [], continuationToken: null };

  // items.items[0] is always the "New playlist" tile; skipped only on the
  // first page (continuation pages are all real playlists).
  const continuationToken = nav(items, ["continuations", 0, "nextContinuationData", "continuation"], true);
  return { playlists: parseGridPlaylistItems(items.items.slice(1)), continuationToken };
}

/**
 * One page of continuation results for the library-playlists grid.
 * Shape per ytmusicapi's generic get_continuations(..., "gridContinuation", ...).
 */
export function parseLibraryPlaylistsContinuation(response) {
  const gridContinuation = nav(response, ["continuationContents", "gridContinuation"], true);
  if (!gridContinuation || !gridContinuation.items) return { playlists: [], continuationToken: null };
  const continuationToken = nav(gridContinuation, ["continuations", 0, "nextContinuationData", "continuation"], true);
  return { playlists: parseGridPlaylistItems(gridContinuation.items), continuationToken };
}

function parseGridPlaylistItems(rawItems) {
  // "Liked Music" itself (browseId VLLM) is skipped wherever it appears —
  // Liked Songs is fetched separately, using its own header metadata, which
  // gives an exact track count where this grid's subtitle for it
  // ("Auto playlist") gives none.
  const playlists = [];
  for (const raw of rawItems) {
    const data = raw[MTRIR];
    if (!data) continue;
    const playlistId = nav(data, [...TITLE, ...NAVIGATION_BROWSE_ID], true);
    if (playlistId === "VLLM") continue;
    const playlist = {
      title: nav(data, TITLE_TEXT, true),
      playlistId: playlistId ? playlistId.slice(2) : null,
      thumbnails: nav(data, THUMBNAIL_RENDERER, true),
      count: null,
    };
    const subtitle = data.subtitle;
    if (subtitle && subtitle.runs && subtitle.runs.length === 3) {
      const countText = nav(data, SUBTITLE2, true) || "";
      if (/\d+ /.test(countText)) {
        const n = parseInt(countText.split(" ")[0], 10);
        playlist.count = Number.isNaN(n) ? null : n;
      }
    }
    if (playlist.playlistId) playlists.push(playlist);
  }
  return playlists;
}

// ---- Search (for the matcher — engine/matcher.js) ----

// The "songs" filter param, ported from ytmusicapi's parsers/search.py
// get_search_params()/_get_param2(): filtered_param1 "EgWKAQ" + songs'
// param2 "II" + the no-ignore-spelling param3 "AWoMEA4QChADEAQQCRAF".
export const SONGS_FILTER_PARAM = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

// Port of parsers/songs.py's parse_song_runs: classifies each run in a
// search-result's remaining flex-column text as artist, album (an MPRE/
// release_detail-prefixed browseId), duration, year, or views.
function parseSongRuns(runs) {
  const parsed = { artists: [], album: null, duration_seconds: null };
  for (let i = 0; i < runs.length; i++) {
    if (i % 2 === 1) continue; // odd indexes are always " • " separators
    const run = runs[i];
    const text = run.text;
    const browseId = nav(run, NAVIGATION_BROWSE_ID, true);
    if (run.navigationEndpoint) {
      const item = { name: text, id: browseId };
      if (browseId && (browseId.startsWith("MPRE") || browseId.includes("release_detail"))) {
        parsed.album = item;
      } else {
        parsed.artists.push(item);
      }
    } else if (/^(\d+:)*\d+:\d+$/.test(text)) {
      parsed.duration = text;
      parsed.duration_seconds = parseDuration(text);
    } else if (/^\d{4}$/.test(text)) {
      parsed.year = text;
    } else if (i > 0 && /^\d\S* \S*$/.test(text)) {
      parsed.views = text.split(" ")[0];
    } else {
      parsed.artists.push({ name: text, id: null });
    }
  }
  return parsed;
}

function parseSongSearchItem(data, resultType) {
  const videoId = nav(data, ["overlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer", "playNavigationEndpoint", "watchEndpoint", "videoId"], true);
  const title = getItemText(data, 0);
  let runs = [];
  const flex1 = getFlexColumnItem(data, 1);
  if (flex1) runs = runs.concat(flex1.text.runs);
  const flex2 = getFlexColumnItem(data, 2);
  if (flex2) runs = runs.concat([{ text: "" }], flex2.text.runs);
  const info = parseSongRuns(runs);
  return {
    resultType,
    videoId,
    title,
    artists: info.artists,
    album: info.album,
    duration_seconds: info.duration_seconds,
  };
}

/**
 * Extracts song/video candidates from a `search` response. Only "Songs" and
 * "Videos" shelves are parsed — matcher.js never needs albums/artists/
 * playlists/etc, matching the reference matcher's own resultType filter.
 */
export function parseSearchResults(response) {
  const results = [];
  if (!response || !response.contents) return results;
  let root = response.contents;
  if (root.tabbedSearchResultsRenderer) {
    root = nav(root, ["tabbedSearchResultsRenderer", "tabs", 0, "tabRenderer", "content"], true) || {};
  }
  const sectionList = nav(root, ["sectionListRenderer", "contents"], true) || [];
  for (const section of sectionList) {
    const shelf = section.musicShelfRenderer;
    if (!shelf || !shelf.contents) continue;
    const shelfTitle = nav(shelf, ["title", "runs", 0, "text"], true) || "";
    let resultType = null;
    if (shelfTitle === "Songs") resultType = "song";
    else if (shelfTitle === "Videos") resultType = "video";
    else continue;
    for (const item of shelf.contents) {
      const data = item[MRLIR];
      if (!data) continue;
      results.push(parseSongSearchItem(data, resultType));
    }
  }
  return results;
}

export function validatePlaylistId(playlistId) {
  return playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
}

export function playlistIdToBrowseId(playlistId) {
  return playlistId.startsWith("VL") ? playlistId : "VL" + playlistId;
}
