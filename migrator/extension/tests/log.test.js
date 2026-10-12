import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDb, fakeYtClient } from "./helpers.js";
import {
  startAction,
  saveAction,
  finishAction,
  logAction,
  listActions,
  performUndo,
  hasUndoableEffect,
  ACTION_TYPES,
  STATUS,
} from "../src/storage/log.js";

beforeEach(() => installFakeIndexedDb());

const t = (videoId, extra = {}) => ({ videoId, title: videoId, artistsDisplay: "", album: "", ...extra });
const PL = (id, title = id) => ({ kind: "playlist", id, title });
const LIKED = { kind: "liked", id: "LM", title: "Liked Music" };

test("write-ahead: a record exists, in progress, before any step is done", async () => {
  const rec = await startAction(ACTION_TYPES.UNLIKE, LIKED, null, [t("a", { unliked: false })]);
  let [stored] = await listActions();
  assert.equal(stored.status, STATUS.IN_PROGRESS);
  assert.equal(hasUndoableEffect(stored), false);

  rec.tracks[0].unliked = true;
  await saveAction(rec);
  await finishAction(rec, new Error("boom"));
  [stored] = await listActions();
  assert.equal(stored.status, STATUS.PARTIAL);
  assert.equal(stored.error, "boom");
  assert.equal(hasUndoableEffect(stored), true);
});

test("undo of a partial un-like only re-likes what was actually un-liked", async () => {
  const client = fakeYtClient({ LM: [] });
  const rec = await startAction(ACTION_TYPES.UNLIKE, LIKED, null, [t("a", { unliked: true }), t("b", { unliked: false })]);
  await finishAction(rec, new Error("failed on b"));
  await performUndo(client, rec);
  assert.deepEqual(client.calls, [["like", "a"]]);
  const [stored] = await listActions();
  assert.equal(stored.undone, true);
});

test("legacy records (no status) assume every step happened", async () => {
  const client = fakeYtClient({ LM: [] });
  const legacy = { actionId: "x", type: ACTION_TYPES.UNLIKE, timestamp: "2026-01-01", source: LIKED, destination: null, tracks: [t("a"), t("b")], undone: false };
  await performUndo(client, legacy);
  assert.deepEqual(client.calls, [["like", "a"], ["like", "b"]]);
});

test("move undo restores the source BEFORE removing from the destination", async () => {
  const client = fakeYtClient({ SRC: [], DST: [{ videoId: "a", setVideoId: "d1" }] });
  const rec = await logAction(ACTION_TYPES.MOVE, PL("SRC"), PL("DST"), [
    t("a", { setVideoId: "s1", addedToDest: true, destSetVideoId: "d1", removedFromSource: true }),
  ]);
  await performUndo(client, rec);
  assert.deepEqual(client.calls, [
    ["add", "SRC", ["a"]],
    ["remove", "DST", ["a"]],
  ]);
});

test("move undo leaves tracks that were already in the destination alone", async () => {
  const client = fakeYtClient({ SRC: [], DST: [{ videoId: "a", setVideoId: "old" }] });
  const rec = await logAction(ACTION_TYPES.MOVE, PL("SRC"), PL("DST"), [
    t("a", { addedToDest: false, destSetVideoId: null, removedFromSource: true }),
  ]);
  await performUndo(client, rec);
  assert.deepEqual(client.calls, [["add", "SRC", ["a"]]]);
  assert.equal(client.state.DST.length, 1);
});

test("a retried move undo doesn't re-add to the source a second time", async () => {
  const client = fakeYtClient({ SRC: [], DST: [{ videoId: "a", setVideoId: "d1" }] });
  const rec = await logAction(ACTION_TYPES.MOVE, PL("SRC"), PL("DST"), [
    t("a", { addedToDest: true, destSetVideoId: "d1", removedFromSource: true }),
  ]);
  const realRemove = client.removePlaylistItems;
  client.removePlaylistItems = async () => {
    throw new Error("network");
  };
  await assert.rejects(performUndo(client, rec));
  client.removePlaylistItems = realRemove;
  await performUndo(client, rec);
  assert.equal(client.calls.filter((c) => c[0] === "add").length, 1);
  assert.equal(client.state.SRC.length, 1);
  assert.equal(client.state.DST.length, 0);
});

test("move into a new playlist: undo deletes the playlist if it only holds what was moved", async () => {
  const client = fakeYtClient({ SRC: [], PLnew: [{ videoId: "a", setVideoId: "d1" }] });
  const rec = await logAction(
    ACTION_TYPES.MOVE,
    PL("SRC"),
    PL("PLnew"),
    [t("a", { addedToDest: true, destSetVideoId: "d1", removedFromSource: true })],
    { createdPlaylistId: "PLnew" }
  );
  await performUndo(client, rec);
  assert.deepEqual(client.calls, [
    ["add", "SRC", ["a"]],
    ["delete", "PLnew"],
  ]);
});

test("undoing a playlist creation refuses to delete a playlist that has tracks in it", async () => {
  // The data-loss path from the review: create → move into it → undo the
  // create first. Must not delete the moved tracks along with the playlist.
  const client = fakeYtClient({ PLnew: [{ videoId: "a", setVideoId: "d1" }] });
  const rec = await logAction(ACTION_TYPES.PLAYLIST_CREATE, null, PL("PLnew", "New"), [], { createdPlaylistId: "PLnew" });
  await assert.rejects(performUndo(client, rec), /isn't empty/);
  assert.deepEqual(client.calls, []);
  const [stored] = await listActions();
  assert.equal(stored.undone, false);
});

test("undoing a playlist creation deletes it when empty", async () => {
  const client = fakeYtClient({ PLnew: [] });
  const rec = await logAction(ACTION_TYPES.PLAYLIST_CREATE, null, PL("PLnew", "New"), [], { createdPlaylistId: "PLnew" });
  await performUndo(client, rec);
  assert.deepEqual(client.calls, [["delete", "PLnew"]]);
});

test("import undo into a created playlist deletes it; into an existing one removes only the added items", async () => {
  const client = fakeYtClient({ PLnew: [{ videoId: "a", setVideoId: "x1" }], OLD: [{ videoId: "k", setVideoId: "k1" }, { videoId: "a", setVideoId: "x2" }] });
  const created = await logAction(ACTION_TYPES.IMPORT, { kind: "amazon", id: "import", title: "Amazon Music import" }, PL("PLnew"), [t("a", { added: true, setVideoId: "x1" })], { createdPlaylistId: "PLnew" });
  await performUndo(client, created);
  const existing = await logAction(ACTION_TYPES.IMPORT, { kind: "jiosaavn", id: "import", title: "JioSaavn import" }, PL("OLD"), [t("a", { added: true, setVideoId: "x2" })]);
  await performUndo(client, existing);
  assert.deepEqual(client.calls, [
    ["delete", "PLnew"],
    ["remove", "OLD", ["a"]],
  ]);
  assert.deepEqual(client.state.OLD.map((x) => x.videoId), ["k"]);
});

test("import undo looks up a missing setVideoId (last copy) instead of skipping the track", async () => {
  const client = fakeYtClient({ OLD: [{ videoId: "a", setVideoId: "first" }, { videoId: "a", setVideoId: "last" }] });
  const rec = await logAction(ACTION_TYPES.IMPORT, { kind: "jiosaavn", id: "import", title: "JioSaavn import" }, PL("OLD"), [t("a", { added: true, setVideoId: null })]);
  await performUndo(client, rec);
  assert.deepEqual(client.state.OLD.map((x) => x.setVideoId), ["first"]);
});

test("an already-undone action can't be undone twice", async () => {
  const client = fakeYtClient({ LM: [] });
  const rec = await logAction(ACTION_TYPES.UNLIKE, LIKED, null, [t("a", { unliked: true })]);
  await performUndo(client, rec);
  await assert.rejects(performUndo(client, rec), /already undone/);
});
