import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLibraryPlaylists, parsePlaylistItem, parseSearchResults, parseDuration } from "../src/ytmusic/parsers.js";
import { trackItem } from "./helpers.js";

function gridItem(title, browseId, countText) {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: title, navigationEndpoint: { browseEndpoint: { browseId } } }] },
      subtitle: { runs: [{ text: "Playlist" }, { text: " • " }, { text: countText }] },
    },
  };
}

test("library playlist counts parse thousands separators", () => {
  const response = {
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      gridRenderer: {
                        items: [
                          { musicTwoRowItemRenderer: {} }, // the "New playlist" tile
                          gridItem("Big", "VLPLbig", "1,234 songs"),
                          gridItem("Small", "VLPLsmall", "12 songs"),
                          gridItem("Liked", "VLLM", "Auto playlist"),
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const { playlists } = parseLibraryPlaylists(response);
  assert.deepEqual(
    playlists.map((p) => [p.playlistId, p.count]),
    [
      ["PLbig", 1234],
      ["PLsmall", 12],
    ]
  );
});

test("parsePlaylistItem reads videoId, setVideoId, title, artist, album, duration", () => {
  const t = parsePlaylistItem(trackItem({ videoId: "v1", setVideoId: "s1", title: "T", artist: "A", album: "Al", duration: "4:05" }).musicResponsiveListItemRenderer);
  assert.equal(t.videoId, "v1");
  assert.equal(t.setVideoId, "s1");
  assert.equal(t.title, "T");
  assert.equal(t.artistsDisplay, "A");
  assert.equal(t.album, "Al");
  assert.equal(t.duration_seconds, 245);
});

test("parseSearchResults only takes Songs and Videos shelves", () => {
  const shelf = (title, items) => ({ musicShelfRenderer: { title: { runs: [{ text: title }] }, contents: items } });
  const response = {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    shelf("Songs", [trackItem({ videoId: "s", title: "Song" })]),
                    shelf("Albums", [trackItem({ videoId: "x", title: "Album" })]),
                    shelf("Videos", [trackItem({ videoId: "v", title: "Video" })]),
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
  const results = parseSearchResults(response);
  assert.deepEqual(
    results.map((r) => [r.resultType, r.videoId]),
    [
      ["song", "s"],
      ["video", "v"],
    ]
  );
});

test("parseDuration", () => {
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("abc"), null);
});
