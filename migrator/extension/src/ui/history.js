// "History": every change this extension made, in plain words, newest
// first, each with an Undo button. Backed by storage/log.js.

import { makeYtMusicClient } from "../ytmusic/client.js";
import { listActions, performUndo, hasUndoableEffect, ACTION_TYPES, STATUS } from "../storage/log.js";
import { h, icon, button, mount, spinner, plural, timeAgo } from "./dom.js";
import { confirmDialog, errorDialog, toast, infoDialog } from "./dialogs.js";
import { pageHeader, emptyState, invalidateLibrary } from "./library.js";

const client = makeYtMusicClient();
let root = null;

export function initHistory(container) {
  root = container;
}

export async function showHistory() {
  mount(root, pageHeader("History", "Everything this extension has changed. Press Undo to reverse any of it."), spinner());
  let actions;
  try {
    actions = await listActions();
  } catch (err) {
    mount(root, pageHeader("History"), emptyState("alert", "Couldn't open your history", String(err.message || err)));
    return;
  }
  if (actions.length === 0) {
    mount(root, pageHeader("History", "Everything this extension has changed. Press Undo to reverse any of it."), emptyState("history", "Nothing here yet", "When you move, remove, un-like or import songs, it shows up here — so you can undo it."));
    return;
  }
  mount(
    root,
    pageHeader("History", "Everything this extension has changed. Press Undo to reverse any of it."),
    h("p", { class: "note" }, icon("help"), "Undo puts songs back where they were, but at the end of the playlist rather than their old spot. If several changes touch the same playlist, undo the newest first."),
    h("div", { class: "history-list" }, actions.map(historyCard))
  );
}

/** A compact list of the most recent few, for the home screen. */
export async function recentActivity(limit = 3) {
  const actions = (await listActions()).slice(0, limit);
  return actions.map((a) => h("div", { class: "recent-row" }, h("div", { class: `history-icon ${a.type}` }, icon(iconFor(a))), h("div", { class: "grow" }, h("div", {}, describe(a)), h("div", { class: "muted small" }, timeAgo(a.timestamp)))));
}

function iconFor(a) {
  return { remove: "trash", unlike: "heart", move: "move", import: "download", playlist_create: "plus" }[a.type] || "history";
}

export function describe(action) {
  const n = plural(action.tracks.length, "song");
  const src = action.source && action.source.title;
  const dst = action.destination && action.destination.title;
  switch (action.type) {
    case ACTION_TYPES.REMOVE:
      return `Removed ${n} from "${src}"`;
    case ACTION_TYPES.UNLIKE:
      return `Un-liked ${n}`;
    case ACTION_TYPES.MOVE:
      return `Moved ${n} from "${src}" to ${action.createdPlaylistId ? "a new playlist, " : ""}"${dst}"`;
    case ACTION_TYPES.PLAYLIST_CREATE:
      return `Created the playlist "${dst}"`;
    case ACTION_TYPES.IMPORT: {
      // Older records all said "JioSaavn import" as their source title.
      const from = ((action.source && action.source.title) || "another app").replace(/ import$/, "");
      const to = action.destination.kind === "liked" ? "your Liked songs" : `${action.createdPlaylistId ? "a new playlist, " : ""}"${dst}"`;
      return `Brought in ${n} from ${from} to ${to}`;
    }
    default:
      return action.type;
  }
}

const FLAG = {
  [ACTION_TYPES.REMOVE]: "removed",
  [ACTION_TYPES.UNLIKE]: "unliked",
  [ACTION_TYPES.MOVE]: "removedFromSource",
  [ACTION_TYPES.IMPORT]: "added",
};

function statusChip(action) {
  if (action.undone) return h("span", { class: "chip success" }, icon("undo"), "Undone");
  if (!action.status || action.status === STATUS.COMPLETE) return null;
  const flag = FLAG[action.type];
  const done = flag ? action.tracks.filter((t) => t[flag]).length : 0;
  return h("span", { class: "chip warn", title: action.error || "" }, icon("alert"), action.status === STATUS.IN_PROGRESS ? `Interrupted — ${done} of ${action.tracks.length} done` : `Stopped by an error — ${done} of ${action.tracks.length} done`);
}

function historyCard(action) {
  const undoable = !action.undone && hasUndoableEffect(action);
  const songs = action.tracks.slice(0, 50);
  const card = h(
    "div",
    { class: `history-card${action.undone ? " undone" : ""}` },
    h("div", { class: `history-icon ${action.type}` }, icon(iconFor(action))),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "history-title" }, describe(action)),
      h("div", { class: "history-meta muted small" }, timeAgo(action.timestamp), statusChip(action)),
      action.tracks.length
        ? h(
            "details",
            { class: "history-songs" },
            h("summary", {}, `Show the ${plural(action.tracks.length, "song")}`),
            h("ul", { class: "mini-list" }, songs.map((t) => h("li", {}, h("strong", {}, t.title || t.videoId), t.artistsDisplay ? ` — ${t.artistsDisplay}` : "")), action.tracks.length > songs.length ? h("li", { class: "muted" }, `…and ${action.tracks.length - songs.length} more`) : null)
          )
        : null
    ),
    undoable
      ? button("Undo", { kind: "secondary", iconName: "undo", onClick: () => undo(action) })
      : !action.undone
        ? h("span", { class: "muted small nothing" }, "Nothing to undo")
        : null
  );
  return card;
}

async function undo(action) {
  const ok = await confirmDialog({
    title: "Undo this?",
    message: `"${describe(action)}" will be reversed.` + (action.type === ACTION_TYPES.REMOVE || action.type === ACTION_TYPES.MOVE ? "\n\nSongs that go back into a playlist are added at the end." : ""),
    confirmText: "Undo it",
  });
  if (!ok) return;
  const dismiss = toast("Undoing…", { duration: 60000 });
  try {
    const { notes } = await performUndo(client, action);
    dismiss();
    invalidateLibrary();
    toast("Done — that's been undone.", { tone: "success" });
    if (notes && notes.length) infoDialog({ title: "Undone — one thing to know", message: notes.join("\n\n") });
  } catch (err) {
    dismiss();
    await errorDialog(err, { title: "Couldn't undo that" });
  }
  showHistory();
}
