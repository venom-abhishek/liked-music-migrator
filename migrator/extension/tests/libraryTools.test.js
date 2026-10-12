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

import { toBackupJson, parseBackup, artistCounts, tracksByArtists } from "../src/engine/libraryTools.js";

test("a backup round-trips: same songs, same video ids, liked stays liked", () => {
  const tracks = [{ title: "तुम ही हो", artistsDisplay: "Arijit Singh", album: "Aashiqui 2", duration_seconds: 262, videoId: "v1", setVideoId: null }];
  const text = toBackupJson({ kind: "liked", id: "LM", title: "Liked songs" }, tracks, new Date("2026-10-12T00:00:00Z"));
  const back = parseBackup(text);
  assert.equal(back.kind, "liked");
  assert.equal(back.title, "Liked songs");
  assert.equal(back.exportedAt, "2026-10-12T00:00:00.000Z");
  assert.deepEqual(back.songs.map((s) => [s.title, s.artists, s.videoId, s.duration_sec, s.collection_type]), [["तुम ही हो", "Arijit Singh", "v1", 262, "liked"]]);
});

test("ChatGPT-build backups (no app field) still load", () => {
  const back = parseBackup(JSON.stringify({ version: 1, collection: { kind: "playlist", title: "Gym" }, tracks: [{ title: "A", artistsDisplay: "B", duration_seconds: 10, videoId: "x" }] }));
  assert.equal(back.title, "Gym");
  assert.equal(back.songs[0].collection_name, "Gym");
});

test("bad backup files are refused with a plain message", () => {
  assert.throws(() => parseBackup("not json"), /couldn't be read/);
  assert.throws(() => parseBackup(JSON.stringify({ version: 2, tracks: [] })), /isn't a Music Mover backup/);
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, tracks: [{ title: "" }] })), /no title/);
});

test("artistCounts counts each credited artist; tracksByArtists selects them", () => {
  const tracks = [
    { title: "1", artists: [{ name: "Pritam" }, { name: "Arijit Singh" }] },
    { title: "2", artists: [{ name: "Arijit Singh" }] },
    { title: "3", artistsDisplay: "Coldplay" },
  ];
  assert.deepEqual(artistCounts(tracks), [
    { name: "Arijit Singh", count: 2 },
    { name: "Coldplay", count: 1 },
    { name: "Pritam", count: 1 },
  ]);
  assert.deepEqual(tracksByArtists(tracks, ["Pritam", "Coldplay"]).map((t) => t.title), ["1", "3"]);
});
