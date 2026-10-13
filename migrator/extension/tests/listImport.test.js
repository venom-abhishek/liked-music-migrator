import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSongList, parseDelimited } from "../src/engine/listImport.js";

test("CSV from an export tool, with quotes, commas and a playlist column", () => {
  const csv = '﻿Track name,Artist name,Album,Playlist name\n"Tum Hi Ho","Arijit Singh","Aashiqui 2",Bollywood\n"Hello, Goodbye","The Beatles","Magical Mystery Tour",Oldies\nKesariya,Arijit Singh; Pritam,Brahmastra,Bollywood\n';
  const r = parseSongList(csv);
  assert.equal(r.format, "spreadsheet");
  assert.deepEqual(r.songs.map((s) => [s.title, s.artists, s.collection_name]), [
    ["Tum Hi Ho", "Arijit Singh", "Bollywood"],
    ["Hello, Goodbye", "The Beatles", "Oldies"],
    ["Kesariya", "Arijit Singh, Pritam", "Bollywood"],
  ]);
  assert.deepEqual(r.collections, [{ name: "Bollywood", count: 2 }, { name: "Oldies", count: 1 }]);
});

test("Exportify-style CSV: durations in milliseconds", () => {
  const r = parseSongList('Track Name,Artist Name(s),Album Name,Duration (ms)\nYellow,Coldplay,Parachutes,266773\n');
  assert.equal(r.songs[0].duration_sec, 267);
});

test("tab-separated, and a 'Liked Songs' list goes to Liked songs", () => {
  const r = parseSongList("Title\tArtist\tPlaylist\tLength\nYellow\tColdplay\tLiked Songs\t4:26\n");
  assert.equal(r.songs[0].collection_type, "liked");
  assert.equal(r.songs[0].duration_sec, 266);
});

test("one song per line: 'Title - Artist', numbered, 'by'", () => {
  const r = parseSongList("1. Tum Hi Ho - Arijit Singh\nYellow – Coldplay\nBlinding Lights by The Weeknd\nJust A Title\n", "My list");
  assert.equal(r.format, "lines");
  assert.deepEqual(r.songs.map((s) => [s.title, s.artists]), [
    ["Tum Hi Ho", "Arijit Singh"],
    ["Yellow", "Coldplay"],
    ["Blinding Lights", "The Weeknd"],
    ["Just A Title", ""],
  ]);
  assert.equal(r.songs[0].collection_name, "My list");
});

test("text copied off a playlist web page: blocks ending in the song's length", () => {
  const copied = [
    "Gym Mix", "Playlist", "22 songs • 1 hour 20 minutes", "Play", "More",
    "1", "Tum Hi Ho", "Arijit Singh", "Aashiqui 2", "4:22",
    "2", "Blinding Lights", "E", "The Weeknd", "After Hours", "3:20",
    "3", "Yellow", "Coldplay", "Parachutes", "4:26",
  ].join("\n");
  const r = parseSongList(copied, "Gym Mix");
  assert.equal(r.format, "copied page");
  assert.deepEqual(r.songs.map((s) => [s.title, s.artists, s.album, s.duration_sec]), [
    ["Tum Hi Ho", "Arijit Singh", "Aashiqui 2", 262],
    ["Blinding Lights", "The Weeknd", "After Hours", 200],
    ["Yellow", "Coldplay", "Parachutes", 266],
  ]);
});

test("empty or useless text is refused with a plain message", () => {
  assert.throws(() => parseSongList("   "), /nothing in the list/);
  assert.throws(() => parseSongList("1\n2\n3"), /No songs/);
});

test("parseDelimited handles quoted newlines and doubled quotes", () => {
  assert.deepEqual(parseDelimited('a,"b ""x""\nc",d\n', ","), [["a", 'b "x"\nc', "d"]]);
});
