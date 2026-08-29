// Minimal port of ytmusicapi's navigation.py: a handful of named JSON paths
// into YouTube Music's internal `browse` response, plus the `nav()` helper
// that walks them. Ported (not reinvented) from the real, working Python
// library the reference desktop tool depends on — see migrator/.venv's
// ytmusicapi package for the source of truth.

export function nav(root, items, noneIfAbsent = false) {
  let cur = root;
  for (const key of items) {
    if (cur == null) {
      if (noneIfAbsent) return null;
      throw new Error(`nav: could not find '${key}' in path ${JSON.stringify(items)}`);
    }
    cur = cur[key];
  }
  return cur === undefined ? (noneIfAbsent ? null : (() => { throw new Error(`nav: undefined at end of path ${JSON.stringify(items)}`); })()) : cur;
}

export const CONTENT = ["contents", 0];
export const RUN_TEXT = ["runs", 0, "text"];
export const TAB_CONTENT = ["tabs", 0, "tabRenderer", "content"];
export const TAB_1_CONTENT = ["tabs", 1, "tabRenderer", "content"];
export const TAB_2_CONTENT = ["tabs", 2, "tabRenderer", "content"];
export const TWO_COLUMN_RENDERER = ["contents", "twoColumnBrowseResultsRenderer"];
export const SINGLE_COLUMN = ["contents", "singleColumnBrowseResultsRenderer"];
export const SINGLE_COLUMN_TAB = [...SINGLE_COLUMN, ...TAB_CONTENT];
export const SECTION = ["sectionListRenderer"];
export const SECTION_LIST = [...SECTION, "contents"];
export const SECTION_LIST_ITEM = [...SECTION, ...CONTENT];
export const RESPONSIVE_HEADER = ["musicResponsiveHeaderRenderer"];
export const ITEM_SECTION = ["itemSectionRenderer", ...CONTENT];
export const GRID = ["gridRenderer"];
export const GRID_ITEMS = [...GRID, "items"];
export const MENU = ["menu", "menuRenderer"];
export const MENU_ITEMS = [...MENU, "items"];
export const MENU_LIKE_STATUS = [...MENU, "topLevelButtons", 0, "likeButtonRenderer", "likeStatus"];
export const MENU_SERVICE = ["menuServiceItemRenderer", "serviceEndpoint"];
export const TOGGLE_MENU = "toggleMenuServiceItemRenderer";
export const OVERLAY_RENDERER = ["musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer"];
export const PLAY_BUTTON = ["overlay", ...OVERLAY_RENDERER];
export const NAVIGATION_BROWSE = ["navigationEndpoint", "browseEndpoint"];
export const NAVIGATION_BROWSE_ID = [...NAVIGATION_BROWSE, "browseId"];
export const WATCH_PLAYLIST_ID = ["watchEndpoint", "playlistId"];
export const TITLE = ["title", "runs", 0];
export const TITLE_TEXT = ["title", ...RUN_TEXT];
export const TEXT_RUNS = ["text", "runs"];
export const TEXT_RUN = [...TEXT_RUNS, 0];
export const TEXT_RUN_TEXT = [...TEXT_RUN, "text"];
export const SUBTITLE_RUNS = ["subtitle", "runs"];
export const SUBTITLE2 = [...SUBTITLE_RUNS, 2, "text"];
export const THUMBNAILS = ["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"];
export const THUMBNAIL_RENDERER = ["thumbnailRenderer", "musicThumbnailRenderer", "thumbnail", "thumbnails"];
export const MRLIR = "musicResponsiveListItemRenderer";
export const MTRIR = "musicTwoRowItemRenderer";
export const SECTION_LIST_CONTINUATION = ["continuationContents", "sectionListContinuation"];
export const HEADER = ["header"];
export const HEADER_DETAIL = [...HEADER, "musicDetailHeaderRenderer"];
export const EDITABLE_PLAYLIST_DETAIL_HEADER = ["musicEditablePlaylistDetailHeaderRenderer"];

// continuations.py
export const CONTINUATION_TOKEN = ["continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token"];
export const CONTINUATION_ITEMS = ["onResponseReceivedActions", 0, "appendContinuationItemsAction", "continuationItems"];

export function getContinuationToken(results) {
  if (!results || results.length === 0) return null;
  return nav(results[results.length - 1], CONTINUATION_TOKEN, true);
}

export function getContinuationParams(results) {
  const ctoken = nav(results, ["continuations", 0, "nextContinuationData", "continuation"]);
  return `&ctoken=${ctoken}&continuation=${ctoken}`;
}

export function findObjectByKey(list, key, nested) {
  for (const item of list) {
    const target = nested ? item[nested] : item;
    if (target && key in target) return target;
  }
  return null;
}
