import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDb, fakeYtClient } from "./helpers.js";
import { commitImport } from "../src/engine/importer.js";
import { listActions, STATUS } from "../src/storage/log.js";

beforeEach(() => installFakeIndexedDb());

const entry = (title, artists, videoId, collection_type = "playlist", collection_name = "Mix") => ({
  song: { title, artists, album: "", collection_type, collection_name },
  match: { decision: "AUTO", chosen: { videoId } },
});

test("single-playlist mode creates the playlist, adds, and logs the source correctly", async () => {
  const client = fakeYtClient({});
  const results = await commitImport(
    client,
    [entry("One", "A", "v1"), entry("Two", "B", "v2"), entry("One", "A", "v1")],
    "single",
    "Amazon Music Import",
    { likedTracks: [], playlists: [] },
    null,
    { kind: "amazon", title: "Amazon Music" }
  );
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["added", "added", "duplicate"]);
  const [rec] = await listActions();
  assert.equal(rec.status, STATUS.COMPLETE);
  assert.equal(rec.source.title, "Amazon Music import");
  assert.ok(rec.createdPlaylistId);
  assert.ok(rec.tracks.every((t) => t.added && t.setVideoId));
});

test("reuses a same-named playlist and skips what's already in it", async () => {
  const client = fakeYtClient({ PLmix: [{ videoId: "v1", setVideoId: "s1", title: "One" }] });
  const results = await commitImport(
    client,
    [entry("One", "Artist", "v1"), entry("Two", "B", "v2")],
    "mirror",
    "",
    { likedTracks: [], playlists: [{ id: "PLmix", title: "Mix" }] },
    null,
    { kind: "jiosaavn", title: "JioSaavn" }
  );
  assert.deepEqual(results.map((r) => r.outcome), ["already_present", "added"]);
  assert.equal(client.calls.filter((c) => c[0] === "create").length, 0);
});

test("a failed add still leaves the created playlist on record (so undo can delete it)", async () => {
  const client = fakeYtClient({});
  client.addPlaylistItems = async () => {
    throw new Error("YouTube Music refused");
  };
  const results = await commitImport(client, [entry("One", "A", "v1")], "single", "X", { likedTracks: [], playlists: [] }, null, {
    kind: "jiosaavn",
    title: "JioSaavn",
  });
  assert.deepEqual(results.map((r) => r.outcome), ["error"]);
  const [rec] = await listActions();
  assert.equal(rec.status, STATUS.PARTIAL);
  assert.ok(rec.createdPlaylistId);
  assert.equal(rec.tracks[0].added, false);
});

test("like-all mode flags each track as it's liked; errors don't stop the rest", async () => {
  const client = fakeYtClient({ LM: [] });
  const realLike = client.likeSong;
  client.likeSong = async (id) => {
    if (id === "v2") throw new Error("rate limited");
    return realLike(id);
  };
  const results = await commitImport(client, [entry("One", "A", "v1"), entry("Two", "B", "v2"), entry("Three", "C", "v3")], "liked", "", { likedTracks: [], playlists: [] }, null, {
    kind: "jiosaavn",
    title: "JioSaavn",
  });
  assert.deepEqual(results.map((r) => r.outcome), ["added", "error", "added"]);
  const [rec] = await listActions();
  assert.deepEqual(rec.tracks.map((t) => t.added), [true, false, true]);
  assert.equal(rec.status, STATUS.PARTIAL);
});
