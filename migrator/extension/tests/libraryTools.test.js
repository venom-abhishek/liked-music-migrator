import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateExtras } from "../src/engine/libraryTools.js";
import { toCsv } from "../src/ui/dom.js";

test("duplicateExtras keeps the first copy and selects later copies of the same video", () => {
  const tracks = [
    { videoId: "a", setVideoId: "1" },
    { videoId: "b", setVideoId: "2" },
    { videoId: "a", setVideoId: "3" },
    { videoId: "a", setVideoId: "4" },
  ];
  assert.deepEqual(duplicateExtras(tracks).map((t) => t.setVideoId), ["3", "4"]);
});

test("duplicateExtras never treats different videos of the same song as duplicates", () => {
  const tracks = [
    { videoId: "a", title: "Yellow", artistsDisplay: "Coldplay" },
    { videoId: "b", title: "Yellow", artistsDisplay: "Coldplay" },
  ];
  assert.equal(duplicateExtras(tracks).length, 0);
});

test("CSV export quotes commas/quotes/newlines and neutralises spreadsheet formulas", () => {
  const csv = toCsv([
    ["Title", "Artist"],
    ['Say "Hi", ok', "A\nB"],
    ["=HYPERLINK(\"x\")", " +1"],
    ["-dash", "@at"],
    ["तुम ही हो", "Arijit"],
  ]);
  const lines = csv.replace(/^﻿/, "").split("\n");
  assert.equal(lines[1], '"Say ""Hi"", ok","A');
  assert.equal(lines[3], `"'=HYPERLINK(""x"")",' +1`);
  assert.equal(lines[4], "'-dash,'@at");
  assert.equal(lines[5], "तुम ही हो,Arijit");
});
