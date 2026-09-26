import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSongsFromCaptures, autoScrollAndCapture } from "../src/engine/amazonExtract.js";

const row = (asin, title, artist, album, dur) => ({
  interface: "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualRowItemElement",
  primaryText: title,
  secondaryText1: artist,
  secondaryText2: album,
  secondaryText3: dur,
  primaryLink: { deeplink: `/albums/B0ALBUM1?trackAsin=${asin}` },
});

const capture = (rows) => ({ body: JSON.stringify({ methods: [{ template: { widgets: [{ items: rows }] } }] }) });

test("extracts rows, decodes entities, de-dups across captures by ASIN", () => {
  const songs = extractSongsFromCaptures(
    [capture([row("B01", "Rock &amp; Roll", "Artist", "Album", "3:05")]), capture([row("B01", "dup", "", "", ""), row("B02", "Two", "A2", "Al2", "1:02:03")])],
    "playlist",
    "My List"
  );
  assert.equal(songs.length, 2);
  assert.deepEqual(songs[0], {
    source: "amazon",
    collection_type: "playlist",
    collection_name: "My List",
    source_id: "B01",
    title: "Rock & Roll",
    artists: "Artist",
    album: "Album",
    duration_sec: 185,
    version_tag: "",
  });
  assert.equal(songs[1].duration_sec, 3723);
});

test("rows without a trackAsin deeplink are ignored", () => {
  const r = row("B01", "x", "y", "z", "1:00");
  r.primaryLink.deeplink = "/artists/B0ART";
  assert.equal(extractSongsFromCaptures([capture([r])], "playlist", "x").length, 0);
});

test("autoScrollAndCapture keeps what loaded before scrolling and stops at the bottom", async () => {
  // A short playlist: everything arrived with the page load, scrolling adds nothing.
  let cleared = false;
  let steps = 0;
  const client = {
    clearCaptures: async () => (cleared = true),
    countCaptures: async () => 1,
    getCaptures: async () => [capture([row("B01", "x", "y", "z", "1:00")])],
    scrollStep: async () => {
      steps++;
      return { scrollHeightBefore: 1000, scrollHeightAfter: 1000, atBottom: true };
    },
  };
  const captures = await autoScrollAndCapture(client, { waitMs: 0 });
  assert.equal(cleared, false, "must not clear the page-load capture");
  assert.equal(captures.length, 1);
  assert.equal(steps, 3);
});

test("autoScrollAndCapture keeps going while the list grows", async () => {
  let height = 1000;
  let steps = 0;
  const client = {
    countCaptures: async () => 0,
    getCaptures: async () => [],
    scrollStep: async () => {
      steps++;
      const before = height;
      if (steps <= 5) height += 500; // five more batches load, then the end
      return { scrollHeightBefore: before, scrollHeightAfter: height, atBottom: steps > 5 };
    },
  };
  await autoScrollAndCapture(client, { waitMs: 0 });
  assert.equal(steps, 8); // 5 growing steps + 3 stable steps at the bottom
});
