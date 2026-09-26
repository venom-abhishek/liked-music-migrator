import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllTracks } from "../src/engine/reconcile.js";
import { playlistPages } from "./helpers.js";

function clientFor(pages) {
  const { firstResponse, continuations } = playlistPages(pages);
  return {
    browse: async () => firstResponse,
    browseContinuationBody: async (token) => continuations[token],
  };
}

test("pages to exhaustion and drops rows repeated across overlapping pages", async () => {
  const client = clientFor([
    [{ videoId: "a", setVideoId: "sa", title: "A" }, { videoId: "b", setVideoId: "sb", title: "B" }],
    [{ videoId: "b", setVideoId: "sb", title: "B" }, { videoId: "c", setVideoId: "sc", title: "C" }],
  ]);
  const tracks = await fetchAllTracks(client, "VLPLx");
  assert.deepEqual(tracks.map((t) => t.videoId), ["a", "b", "c"]);
  assert.deepEqual(tracks.map((t) => t._fetchIndex), [0, 1, 2]);
});

test("keeps two copies of the same song in a playlist (different setVideoIds)", async () => {
  const client = clientFor([
    [
      { videoId: "a", setVideoId: "s1", title: "A" },
      { videoId: "a", setVideoId: "s2", title: "A" },
    ],
  ]);
  const tracks = await fetchAllTracks(client, "VLPLx");
  assert.deepEqual(tracks.map((t) => t.setVideoId), ["s1", "s2"]);
});

test("Liked Songs rows (no setVideoId) de-dup by videoId", async () => {
  const client = clientFor([[{ videoId: "a", title: "A" }], [{ videoId: "a", title: "A" }, { videoId: "b", title: "B" }]]);
  const tracks = await fetchAllTracks(client, "VLLM");
  assert.deepEqual(tracks.map((t) => t.videoId), ["a", "b"]);
});
