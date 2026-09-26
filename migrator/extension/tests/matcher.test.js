import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSong, AUTO, REVIEW, NOT_FOUND } from "../src/engine/matcher.js";
import { trackItem } from "./helpers.js";

// In search results, duration isn't a fixed column (as in a playlist) —
// it's the last run of the artist line: "Artist • Album • 4:15".
function searchItem(song) {
  const item = trackItem(song);
  const runs = item.musicResponsiveListItemRenderer.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs;
  runs.push({ text: " • " }, { text: song.duration });
  return item;
}

function searchResponse(songs) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{ musicShelfRenderer: { title: { runs: [{ text: "Songs" }] }, contents: songs.map(searchItem) } }],
                },
              },
            },
          },
        ],
      },
    },
  };
}

function searchClient(songs) {
  return { search: async () => searchResponse(songs) };
}

const src = (title, artists, duration_sec) => ({ title, artists, duration_sec, version_tag: "" });

test("exact title/artist/duration is AUTO", async () => {
  const m = await matchSong(src("Tum Hi Ho", "Arijit Singh", 262), searchClient([{ videoId: "v", title: "Tum Hi Ho", artist: "Arijit Singh", duration: "4:22" }]));
  assert.equal(m.decision, AUTO);
  assert.equal(m.chosen.videoId, "v");
});

test("wrong artist never auto-matches", async () => {
  const m = await matchSong(src("Tum Hi Ho", "Arijit Singh", 262), searchClient([{ videoId: "v", title: "Tum Hi Ho", artist: "Some Cover Band", duration: "4:22" }]));
  assert.notEqual(m.decision, AUTO);
});

test("artist in a different script goes to REVIEW, not AUTO", async () => {
  const m = await matchSong(src("Lemon", "Kenshi Yonezu", 255), searchClient([{ videoId: "v", title: "Lemon", artist: "米津玄師", duration: "4:15" }]));
  assert.equal(m.decision, REVIEW);
});

test("no results is NOT_FOUND", async () => {
  const m = await matchSong(src("Nothing", "Nobody", 100), searchClient([]));
  assert.equal(m.decision, NOT_FOUND);
  assert.equal(m.reason, "no_results");
});
