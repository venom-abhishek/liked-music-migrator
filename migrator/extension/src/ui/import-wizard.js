// "Bring songs in": a step-by-step wizard that walks someone with no
// technical knowledge through importing from JioSaavn or Amazon Music.
//
//   1 Choose app → 2 Connect → 3 Pick songs → 4 Check matches → 5 Add
//
// Nothing is written to YouTube Music until the final "Add" button, which
// states exactly how many songs go where. Matching is the deterministic
// engine/matcher.js (no AI); this file is only screens and flow.

import { makeYtMusicClient } from "../ytmusic/client.js";
import { fetchAllTracks, fetchAllLibraryPlaylists } from "../engine/reconcile.js";
import { makeJioSaavnClient } from "../sources/jiosaavnClient.js";
import { getJioSaavnInventory, extractJioSaavnSongs } from "../engine/jiosaavnExtract.js";
import { findAmazonTab, makeAmazonClient } from "../sources/amazonClient.js";
import { autoScrollAndCapture, extractSongsFromCaptures } from "../engine/amazonExtract.js";
import { matchSong, AUTO, REVIEW, NOT_FOUND } from "../engine/matcher.js";
import { commitImport } from "../engine/importer.js";
import { performUndo } from "../storage/log.js";
import { h, icon, button, mount, spinner, plural, sleep, downloadText, toCsv } from "./dom.js";
import { confirmDialog, errorDialog, toast, infoDialog } from "./dialogs.js";
import { connectionCard, reloadTab, focusTab } from "./connection.js";
import { pageHeader, emptyState, invalidateLibrary } from "./library.js";

const client = makeYtMusicClient();
const jiosaavn = makeJioSaavnClient();

const MATCH_ERROR = "ERROR"; // the search itself failed — not the same as "not on YouTube Music"
// Searches run a few at a time. There is deliberately NO fixed pause
// between searches: Chrome stretches any timer in a background tab to at
// least 1 second, so a "small" pause per song became ~1s per song as soon as
// the user switched tabs (an earlier version did exactly that, and a
// 500-song import got 8+ minutes slower). Pauses only happen after an
// error, when backing off is the point.
const SEARCH_CONCURRENCY = 3;
const ERROR_BACKOFF_MS = 2000;
const PAGE = 150; // rows rendered per list before "Show more"

const SOURCES = {
  jiosaavn: { key: "jiosaavn", name: "JioSaavn", logText: "JioSaavn", blurb: "Your liked songs and playlists" },
  amazon: { key: "amazon", name: "Amazon Music", logText: "Amazon Music", blurb: "One playlist or song list at a time", beta: true },
};

const STEPS = ["Choose app", "Connect", "Pick songs", "Check matches", "Add"];
const STEP_OF = { source: 0, connect: 1, choose: 2, reading: 2, matching: 3, review: 3, destination: 4, adding: 4, done: 4 };

let root = null;
let w = null; // wizard state
let onNavigate = null;

function freshState() {
  return {
    step: "source",
    source: null,
    inventory: null, // JioSaavn: { liked, playlists }
    pickLiked: true,
    pickPlaylists: new Set(), // indexes
    amazonName: "",
    amazonIsLiked: false,
    songs: [],
    matches: [], // [{ song, match, include }]
    warnings: [],
    reviewTab: "ready",
    shown: { ready: PAGE, check: PAGE, missing: PAGE },
    mode: null,
    playlistName: "",
    cancelled: false,
    results: null,
    records: [],
    busy: null,
  };
}

export function initImportWizard(container, { navigate }) {
  root = container;
  onNavigate = navigate;
  w = freshState();
}

export function showImportWizard() {
  render();
}

/** True while matching/adding is running — the app warns before leaving the page. */
export function importIsBusy() {
  return w && (w.step === "matching" || w.step === "adding" || w.step === "reading");
}

function go(step) {
  w.step = step;
  render();
  root.scrollTop = 0;
  window.scrollTo(0, 0);
}

function render() {
  const screens = { source, connect, choose, reading, matching, review, destination, adding, done };
  mount(root, pageHeader("Bring songs in", "Copy your songs from another music app into YouTube Music."), stepper(), h("div", { class: "wizard-body" }, screens[w.step]()));
}

function stepper() {
  const at = STEP_OF[w.step];
  return h(
    "ol",
    { class: "stepper", "aria-label": "Progress" },
    STEPS.map((label, i) =>
      h(
        "li",
        { class: i < at ? "done" : i === at ? "current" : "", "aria-current": i === at ? "step" : null },
        h("span", { class: "step-dot" }, i < at ? icon("check") : String(i + 1)),
        h("span", { class: "step-label" }, label)
      )
    )
  );
}

function nav(backStep, next) {
  return h("div", { class: "wizard-nav" }, backStep ? button("Back", { kind: "ghost", iconName: "back", onClick: () => go(backStep) }) : h("span"), next || null);
}

// ---- 1. Choose app ----

function source() {
  const card = (s) =>
    h(
      "button",
      {
        class: "choice-card",
        onclick: () => {
          w = freshState();
          w.source = s;
          go("connect");
        },
      },
      h("div", { class: `service-logo ${s.key}` }, s.name[0]),
      h("div", {}, h("strong", {}, s.name, s.beta ? h("span", { class: "chip" }, "Beta") : null), h("span", { class: "muted" }, s.blurb)),
      icon("forward", "chev")
    );
  return h(
    "div",
    {},
    h("h2", {}, "Where are your songs now?"),
    h("div", { class: "choice-grid" }, card(SOURCES.jiosaavn), card(SOURCES.amazon)),
    h(
      "p",
      { class: "muted small reassure" },
      icon("checkCircle"),
      "Nothing is changed in your YouTube Music until the very last step, and everything this adds can be undone."
    )
  );
}

// ---- 2. Connect ----

function connect() {
  const s = w.source;
  const next = button("Continue", { kind: "primary", iconName: "forward", disabled: true, onClick: () => go("choose") });
  const states = {};
  const update = (key) => (state) => {
    states[key] = state;
    next.disabled = !(states.youtube === "ok" && states[s.key] === "ok");
  };
  return h(
    "div",
    {},
    h("h2", {}, "Open both apps in this browser"),
    h("p", { class: "muted" }, `This works using the ${s.name} and YouTube Music tabs you're already signed in to — so you never type a password here. Keep both tabs open until the import is done.`),
    h("div", { class: "conn-stack" }, connectionCard(s.key, { onChange: update(s.key) }), connectionCard("youtube", { onChange: update("youtube") })),
    s.key === "jiosaavn" ? h("p", { class: "muted small" }, "Make sure you're signed in on JioSaavn too — otherwise your library will look empty.") : null,
    nav("source", next)
  );
}

// ---- 3. Pick songs ----

function choose() {
  return w.source.key === "jiosaavn" ? chooseJioSaavn() : chooseAmazon();
}

function chooseJioSaavn() {
  if (!w.inventory) {
    const box = h("div", {}, spinner("Looking at your JioSaavn library…"));
    getJioSaavnInventory(jiosaavn)
      .then((inv) => {
        w.inventory = inv;
        w.pickLiked = inv.liked.count > 0;
        w.pickPlaylists = new Set(inv.playlists.map((_p, i) => i));
        if (w.step === "choose") render();
      })
      .catch((err) => {
        mount(box, emptyState("alert", "Couldn't read your JioSaavn library", "Check that the JioSaavn tab is open and you're signed in, then try again.", button("Try again", { kind: "primary", iconName: "refresh", onClick: render })));
        console.warn(err);
      });
    return h("div", {}, h("h2", {}, "What should we bring over?"), box, nav("connect"));
  }

  const inv = w.inventory;
  const total = () => (w.pickLiked ? inv.liked.count : 0) + inv.playlists.reduce((n, p, i) => n + (w.pickPlaylists.has(i) ? p.count : 0), 0);
  const summary = h("strong");
  const next = button("Find these songs on YouTube Music", { kind: "primary", iconName: "search" });
  const refresh = () => {
    const n = total();
    summary.textContent = n ? `${plural(n, "song")} selected` : "Nothing selected yet";
    next.disabled = n === 0;
  };
  next.addEventListener("click", startJioSaavn);

  if (inv.liked.count === 0 && inv.playlists.length === 0) {
    return h(
      "div",
      {},
      h("h2", {}, "What should we bring over?"),
      emptyState("music", "Your JioSaavn library looks empty", "If you do have liked songs or playlists there, you're probably not signed in on the JioSaavn tab. Sign in, then check again.", button("Check again", { kind: "primary", iconName: "refresh", onClick: () => ((w.inventory = null), render()) })),
      nav("connect")
    );
  }

  const row = (checked, onChange, iconName, title, count) =>
    h("label", { class: "pick-option" }, h("input", { type: "checkbox", class: "check", checked, onchange: (e) => (onChange(e.target.checked), refresh()) }), h("div", { class: "playlist-art tiny" }, icon(iconName)), h("div", { class: "grow" }, h("strong", {}, title)), h("span", { class: "muted" }, plural(count, "song")));

  const playlistBoxes = [];
  const allBtn = (checked) =>
    button(checked ? "Select all" : "Select none", {
      kind: "ghost",
      size: "sm",
      onClick: () => {
        w.pickLiked = checked && inv.liked.count > 0;
        inv.playlists.forEach((_p, i) => (checked ? w.pickPlaylists.add(i) : w.pickPlaylists.delete(i)));
        render();
      },
    });
  refresh();
  return h(
    "div",
    {},
    h("div", { class: "row-between" }, h("h2", {}, "What should we bring over?"), h("div", {}, allBtn(true), allBtn(false))),
    h(
      "div",
      { class: "pick-list" },
      inv.liked.count ? row(w.pickLiked, (v) => (w.pickLiked = v), "heart", "Liked songs", inv.liked.count) : null,
      inv.playlists.map((p, i) => {
        const r = row(w.pickPlaylists.has(i), (v) => (v ? w.pickPlaylists.add(i) : w.pickPlaylists.delete(i)), "music", p.name || "Untitled playlist", p.count);
        playlistBoxes.push(r);
        return r;
      })
    ),
    h("div", { class: "sticky-summary" }, summary, next),
    nav("connect")
  );
}

async function startJioSaavn() {
  go("reading");
  try {
    const inv = w.inventory;
    const selection = { liked: w.pickLiked ? inv.liked : null, playlists: inv.playlists.filter((_p, i) => w.pickPlaylists.has(i)) };
    const extraction = await extractJioSaavnSongs(jiosaavn, selection);
    w.songs = extraction.songs;
    w.warnings = extraction.warnings;
    await runMatching();
  } catch (err) {
    go("choose");
    errorDialog(err, { title: "Couldn't read your songs from JioSaavn" });
  }
}

function chooseAmazon() {
  const nameInput = h("input", { type: "text", class: "input", value: w.amazonName, placeholder: "e.g. My Amazon favourites", oninput: (e) => (w.amazonName = e.target.value) });
  const likedBox = h("input", { type: "checkbox", class: "check", checked: w.amazonIsLiked, onchange: (e) => (w.amazonIsLiked = e.target.checked) });

  // Prefill the name from the Amazon tab's page title.
  if (!w.amazonName) {
    findAmazonTab().then((tab) => {
      if (!tab || w.amazonName) return;
      const guess = (tab.title || "").replace(/\s*[|\-–]\s*Amazon Music.*$/i, "").trim();
      if (guess && !/^amazon music$/i.test(guess)) {
        w.amazonName = guess;
        nameInput.value = guess;
      }
    });
  }

  const reloadBtn = button("Reload the Amazon tab for me", {
    kind: "secondary",
    iconName: "refresh",
    onClick: async () => {
      const tab = await findAmazonTab();
      if (tab) {
        await reloadTab(tab);
        toast("Reloaded. Wait until you see your songs in the Amazon tab, then continue.", { tone: "success" });
      }
    },
  });
  const showBtn = button("Show me the Amazon tab", { kind: "ghost", iconName: "external", onClick: async () => { const tab = await findAmazonTab(); if (tab) focusTab(tab); } });

  return h(
    "div",
    {},
    h("h2", {}, "Which Amazon songs should we bring over?"),
    h("p", { class: "muted" }, "Amazon Music is done one list at a time: whichever playlist (or song list) is open in the Amazon tab is the one that gets copied."),
    h(
      "ol",
      { class: "howto" },
      h("li", {}, h("strong", {}, "In the Amazon Music tab, open the playlist you want to copy"), " — or go to Library → Songs for all your songs.", h("div", { class: "howto-actions" }, showBtn)),
      h("li", {}, h("strong", {}, "Reload that tab"), " so we can see the songs from the start.", h("div", { class: "howto-actions" }, reloadBtn)),
      h("li", {}, h("strong", {}, "Wait until the songs appear"), " in the Amazon tab, then come back here.")
    ),
    h("label", { class: "field-label" }, "What's this list called?"),
    nameInput,
    h("label", { class: "check-row" }, likedBox, h("span", {}, "These are my liked / saved songs on Amazon (so they can go into Liked songs)")),
    h("div", { class: "wizard-nav" }, button("Back", { kind: "ghost", iconName: "back", onClick: () => go("connect") }), button("Read the songs from Amazon", { kind: "primary", iconName: "download", onClick: startAmazon })),
    h("p", { class: "muted small" }, "We only read what the Amazon page is already showing you. We never see or use your Amazon password.")
  );
}

async function startAmazon() {
  const tab = await findAmazonTab();
  if (!tab) {
    errorDialog(new Error("Couldn't reach the Amazon Music tab"), { title: "Amazon Music isn't open" });
    return;
  }
  w.busy = { text: "Scrolling through the Amazon page to see every song…", sub: "Please don't use the Amazon tab while this runs." };
  go("reading");
  try {
    const amazon = makeAmazonClient(tab.id);
    const captures = await autoScrollAndCapture(amazon, {
      onProgress: (text) => {
        w.busy.sub = text.replace(/^Scrolling the Amazon tab \(step (\d+)\) — /, "Step $1 — ");
        const el = root.querySelector(".busy-sub");
        if (el) el.textContent = w.busy.sub;
      },
    });
    const name = w.amazonName.trim() || "Amazon Music";
    w.songs = extractSongsFromCaptures(captures, w.amazonIsLiked ? "liked" : "playlist", name);
    w.warnings = [];
    if (w.songs.length === 0) {
      go("choose");
      infoDialog({
        title: "We didn't find any songs on that page",
        iconName: "alert",
        tone: "danger",
        message:
          captures.length === 0
            ? "Make sure the Amazon tab is showing the playlist or song list you want, reload that tab, wait for the songs to appear, then try again."
            : "The Amazon page loaded, but its songs weren't in a form we recognise. Amazon may have changed their website — this part may need an update.",
      });
      return;
    }
    toast(`Found ${plural(w.songs.length, "song")} on the Amazon page.`, { tone: "success" });
    await runMatching();
  } catch (err) {
    go("choose");
    errorDialog(err, { title: "Couldn't read the songs from Amazon" });
  }
}

function reading() {
  const b = w.busy || { text: `Reading your songs from ${w.source.name}…`, sub: "This takes a few seconds." };
  return h("div", { class: "busy-screen" }, h("div", { class: "spinner large" }), h("h2", {}, b.text), h("p", { class: "muted busy-sub" }, b.sub));
}

// ---- 4. Matching + review ----

let backoffUntil = 0; // shared by all workers: after an error, everyone pauses briefly

async function searchAndMatch(song) {
  // One retry after a pause: a single failed search is usually a transient
  // network blip or a brief rate limit, not a real answer.
  for (let attempt = 0; ; attempt++) {
    const wait = backoffUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await matchSong(song, client);
    } catch (err) {
      backoffUntil = Math.max(backoffUntil, Date.now() + ERROR_BACKOFF_MS);
      if (attempt >= 1) return { decision: MATCH_ERROR, reason: String(err.message || err) };
    }
  }
}

async function runMatching(onlyIndexes) {
  w.cancelled = false;
  if (!onlyIndexes) w.matches = w.songs.map((song) => ({ song, match: null, include: false }));
  const todo = onlyIndexes || w.matches.map((_m, i) => i);
  w.progress = { done: 0, total: todo.length, current: "", startedAt: Date.now() };
  go("matching");

  let next = 0;
  async function worker() {
    while (!w.cancelled && next < todo.length) {
      const entry = w.matches[todo[next++]];
      w.progress.current = `${entry.song.title} — ${entry.song.artists}`;
      updateMatchingProgress();
      entry.match = await searchAndMatch(entry.song);
      entry.include = entry.match.decision === AUTO;
      w.progress.done++;
      updateMatchingProgress();
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, todo.length) }, worker));

  if (w.cancelled && w.matches.every((m) => !m.match)) return go("choose");
  w.reviewTab = "ready";
  go("review");
}

function matching() {
  const p = w.progress;
  return h(
    "div",
    { class: "busy-screen" },
    h("h2", {}, "Finding your songs on YouTube Music…"),
    h("div", { class: "progress" }, h("div", { class: "progress-fill", style: { width: `${pct(p)}%` } })),
    h("p", { class: "progress-count" }, `${p.done.toLocaleString()} of ${plural(p.total, "song")}`),
    h("p", { class: "muted busy-sub" }, p.current),
    h("p", { class: "muted small eta-line" }, etaText(p)),
    button("Stop", {
      kind: "ghost",
      iconName: "x",
      onClick: () => {
        w.cancelled = true;
      },
    })
  );
}

function pct(p) {
  return p.total ? Math.round((p.done / p.total) * 100) : 0;
}

function eta(p) {
  // Measured speed once a few songs are done; a rough guess before that.
  const perSong = p.done >= 5 ? (Date.now() - p.startedAt) / 1000 / p.done : 0.4;
  const secs = Math.max(0, (p.total - p.done) * perSong);
  if (secs < 60) return "less than a minute";
  const mins = Math.round(secs / 60);
  return plural(mins, "minute");
}

function updateMatchingProgress() {
  if (w.step !== "matching") return;
  const p = w.progress;
  const fill = root.querySelector(".progress-fill");
  if (fill) fill.style.width = `${pct(p)}%`;
  const count = root.querySelector(".progress-count");
  if (count) count.textContent = `${p.done.toLocaleString()} of ${plural(p.total, "song")}`;
  const sub = root.querySelector(".busy-sub");
  if (sub) sub.textContent = p.current;
  const etaEl = root.querySelector(".eta-line");
  if (etaEl) etaEl.textContent = etaText(p);
}

function etaText(p) {
  return `About ${eta(p)} left. You can switch to another tab meanwhile — just don't close this one.`;
}

function buckets() {
  const ready = [];
  const check = [];
  const missing = [];
  w.matches.forEach((m, i) => {
    if (!m.match) return;
    if (m.match.decision === AUTO) ready.push(i);
    else if (m.match.decision === REVIEW) check.push(i);
    else missing.push(i);
  });
  return { ready, check, missing };
}

function review() {
  const b = buckets();
  const selected = w.matches.filter((m) => m.include).length;
  const errors = b.missing.filter((i) => w.matches[i].match.decision === MATCH_ERROR);
  const stopped = w.matches.some((m) => !m.match);

  const tile = (key, tone, iconName, n, label, hint) =>
    h(
      "button",
      { class: `stat-tile tone-${tone}${w.reviewTab === key ? " active" : ""}`, onclick: () => ((w.reviewTab = key), render()) },
      h("div", { class: "stat-icon" }, icon(iconName)),
      h("div", {}, h("div", { class: "stat-num" }, n.toLocaleString()), h("div", { class: "stat-label" }, label), h("div", { class: "muted small" }, hint))
    );

  const tabContent = { ready: readyList, check: checkList, missing: missingList }[w.reviewTab](b);
  const next = button(selected ? `Continue with ${plural(selected, "song")}` : "Continue", { kind: "primary", iconName: "forward", disabled: selected === 0, onClick: () => go("destination") });

  return h(
    "div",
    {},
    h("h2", {}, "Here's what we found"),
    stopped ? h("p", { class: "note" }, icon("help"), "You stopped the search early, so only the songs searched so far are shown.") : null,
    w.warnings && w.warnings.length ? h("p", { class: "note" }, icon("help"), `${plural(w.warnings.length, "list")} had a few songs JioSaavn couldn't give us (usually songs no longer available there).`) : null,
    h(
      "div",
      { class: "stat-grid" },
      tile("ready", "success", "checkCircle", b.ready.length, "Ready to add", "Found a clear match"),
      tile("check", "warn", "help", b.check.length, "Please check", "Probably right — you decide"),
      tile("missing", "danger", "xCircle", b.missing.length, "Not found", "Couldn't find these")
    ),
    errors.length
      ? h(
          "p",
          { class: "note danger" },
          icon("alert"),
          `${plural(errors.length, "song")} couldn't be searched because of a connection problem. `,
          button("Try those again", { kind: "secondary", size: "sm", iconName: "refresh", onClick: () => runMatching(errors) })
        )
      : null,
    tabContent,
    h("div", { class: "sticky-summary" }, h("strong", {}, selected ? `${plural(selected, "song")} will be added` : "No songs selected"), next),
    nav("choose")
  );
}

function listHeader(title, text, ...actions) {
  return h("div", { class: "list-head" }, h("div", {}, h("h3", {}, title), text ? h("p", { class: "muted small" }, text) : null), actions.length ? h("div", { class: "list-head-actions" }, actions) : null);
}

function showMore(key, total) {
  if (w.shown[key] >= total) return null;
  return button(`Show ${Math.min(PAGE, total - w.shown[key])} more`, { kind: "ghost", onClick: () => ((w.shown[key] += PAGE), render()) });
}

function setAll(indexes, value) {
  indexes.forEach((i) => (w.matches[i].include = value));
  render();
}

function includeBox(i) {
  return h("input", {
    type: "checkbox",
    class: "check",
    checked: w.matches[i].include,
    "aria-label": "Add this song",
    onchange: (e) => {
      w.matches[i].include = e.target.checked;
      render();
    },
  });
}

function listenLink(videoId) {
  return h("a", { class: "link-btn", href: `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`, target: "_blank", rel: "noopener", title: "Opens in a new tab so you can check it" }, icon("play"), "Listen");
}

function readyList(b) {
  if (!b.ready.length) return emptyState("search", "No clear matches", "Check the other two lists.");
  return h(
    "div",
    {},
    listHeader("Ready to add", "These are clear matches and are ticked already. Untick any you don't want.", button("Tick all", { kind: "ghost", size: "sm", onClick: () => setAll(b.ready, true) }), button("Untick all", { kind: "ghost", size: "sm", onClick: () => setAll(b.ready, false) })),
    h(
      "div",
      { class: "result-list" },
      b.ready.slice(0, w.shown.ready).map((i) => {
        const { song, match } = w.matches[i];
        return h("label", { class: "result-row" }, includeBox(i), h("div", { class: "grow" }, h("strong", {}, song.title), h("div", { class: "muted small" }, song.artists)), listenLink(match.chosen.videoId));
      })
    ),
    showMore("ready", b.ready.length)
  );
}

function checkList(b) {
  if (!b.check.length) return emptyState("checkCircle", "Nothing to check", "Every song was either a clear match or not found.");
  return h(
    "div",
    {},
    listHeader("Please check these", "We found something close, but not certain. Tick the ones that look right — press Listen to hear it first.", button("Tick all", { kind: "ghost", size: "sm", onClick: () => setAll(b.check, true) })),
    h(
      "div",
      { class: "result-list" },
      b.check.slice(0, w.shown.check).map((i) => {
        const { song, match } = w.matches[i];
        const c = match.chosen;
        return h(
          "label",
          { class: "result-row compare" },
          includeBox(i),
          h("div", { class: "compare-side" }, h("span", { class: "tag" }, `On ${w.source.name}`), h("strong", {}, song.title), h("div", { class: "muted small" }, song.artists)),
          icon("forward", "compare-arrow"),
          h("div", { class: "compare-side" }, h("span", { class: "tag" }, "We found"), h("strong", {}, c.title), h("div", { class: "muted small" }, c.artists || "Unknown artist")),
          listenLink(c.videoId)
        );
      })
    ),
    showMore("check", b.check.length)
  );
}

function missingList(b) {
  if (!b.missing.length) return emptyState("checkCircle", "Everything was found", "Nice — there's nothing missing.");
  const save = () => {
    const rows = [["Title", "Artist", "Album", "From"]].concat(b.missing.map((i) => {
      const s = w.matches[i].song;
      return [s.title, s.artists, s.album, s.collection_name];
    }));
    downloadText(`Songs not found on YouTube Music - ${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
    toast("Saved the list to your Downloads folder.", { tone: "success" });
  };
  return h(
    "div",
    {},
    listHeader("Not found", "We couldn't find these on YouTube Music. Some may not be on YouTube Music at all. You can search for them yourself, or save the list.", button("Save this list", { kind: "ghost", size: "sm", iconName: "save", onClick: save })),
    h(
      "div",
      { class: "result-list" },
      b.missing.slice(0, w.shown.missing).map((i) => {
        const { song, match } = w.matches[i];
        const q = `${song.title} ${song.artists}`.trim();
        return h(
          "div",
          { class: "result-row" },
          h("div", { class: "result-icon" }, icon(match.decision === MATCH_ERROR ? "alert" : "xCircle")),
          h("div", { class: "grow" }, h("strong", {}, song.title), h("div", { class: "muted small" }, song.artists, match.decision === MATCH_ERROR ? " · search failed" : "")),
          h("a", { class: "link-btn", href: `https://music.youtube.com/search?q=${encodeURIComponent(q)}`, target: "_blank", rel: "noopener" }, icon("search"), "Search")
        );
      })
    ),
    showMore("missing", b.missing.length)
  );
}

// ---- 5. Destination + add ----

function collectionsInImport() {
  const names = new Set(w.matches.filter((m) => m.include).map((m) => (m.song.collection_type === "liked" ? "♥" : m.song.collection_name)));
  return names;
}

function destination() {
  const selected = w.matches.filter((m) => m.include);
  const cols = collectionsInImport();
  const hasPlaylists = [...cols].some((n) => n !== "♥");
  const defaultName = w.source.key === "amazon" && (w.amazonName || "").trim() ? w.amazonName.trim() : `From ${w.source.name}`;
  if (!w.playlistName) w.playlistName = defaultName;
  if (!w.mode) w.mode = w.source.key === "amazon" ? (w.amazonIsLiked ? "liked" : "single") : hasPlaylists ? "mirror" : "liked";

  const nameInput = h("input", { type: "text", class: "input", value: w.playlistName, "aria-label": "Playlist name", oninput: (e) => ((w.playlistName = e.target.value), update()) });
  const go_ = button("", { kind: "primary", iconName: "download", onClick: startAdding });

  const option = (mode, iconName, title, text, extra) =>
    h(
      "label",
      { class: `radio-card${w.mode === mode ? " active" : ""}` },
      h("input", { type: "radio", name: "mode", class: "radio", checked: w.mode === mode, onchange: () => ((w.mode = mode), render()) }),
      h("div", { class: "playlist-art tiny" }, icon(iconName)),
      h("div", { class: "grow" }, h("strong", {}, title), h("div", { class: "muted small" }, text), extra && w.mode === mode ? extra : null)
    );

  function update() {
    const n = selected.length;
    let label;
    if (w.mode === "liked") label = `Add ${plural(n, "song")} to Liked songs`;
    else if (w.mode === "single") label = `Add ${plural(n, "song")} to "${w.playlistName.trim() || "…"}"`;
    else label = `Add ${plural(n, "song")}`;
    go_.querySelector("span:last-child").textContent = label;
    go_.disabled = w.mode === "single" && !w.playlistName.trim();
  }

  const mirrorText =
    `Liked songs go into your Liked songs, and each ${w.source.name} playlist becomes a YouTube Music playlist with the same name ` +
    `(${plural([...cols].filter((n) => n !== "♥").length, "playlist")}). If one with that name already exists, the songs are added to it.`;

  const view = h(
    "div",
    {},
    h("h2", {}, "Where should the songs go?"),
    h(
      "div",
      { class: "radio-stack" },
      w.source.key === "jiosaavn" && hasPlaylists ? option("mirror", "list", "Same as on JioSaavn (recommended)", mirrorText) : null,
      option("liked", "heart", "Add them to my Liked songs", "Every song gets a like. Easy to find later under Liked songs."),
      option("single", "music", "Put them all in one playlist", "If a playlist with this name already exists, the songs are added to it.", h("div", { class: "inline-field" }, nameInput))
    ),
    h("p", { class: "muted small reassure" }, icon("checkCircle"), "Songs already in the destination are skipped, so running this again won't create doubles. You can undo the whole import afterwards."),
    h("div", { class: "wizard-nav" }, button("Back", { kind: "ghost", iconName: "back", onClick: () => go("review") }), go_)
  );
  update();
  return view;
}

async function startAdding() {
  const selected = w.matches.filter((m) => m.include);
  const where = w.mode === "liked" ? "your Liked songs" : w.mode === "single" ? `the playlist "${w.playlistName.trim()}"` : "matching playlists";
  const ok = await confirmDialog({
    title: `Add ${plural(selected.length, "song")} to YouTube Music?`,
    message: `They'll go into ${where}. This takes about ${Math.max(1, Math.round((selected.length * 0.2) / 60))} minute(s). You can undo it afterwards.`,
    confirmText: "Yes, add them",
  });
  if (!ok) return;
  w.addingText = "Checking what's already in your YouTube Music…";
  w.records = [];
  go("adding");
  try {
    const likedTracks = await fetchAllTracks(client, "VLLM");
    const playlists = (await fetchAllLibraryPlaylists(client)).map((p) => ({ id: p.playlistId, title: p.title }));
    // commitImport takes { song, match } entries; REVIEW matches the user
    // ticked are included exactly like AUTO ones — the user made the call.
    const entries = selected.map((m) => ({ song: m.song, match: m.match }));
    w.results = await commitImport(
      client,
      entries,
      w.mode,
      w.playlistName.trim(),
      { likedTracks, playlists },
      (text) => {
        w.addingText = text.replace(/^Writing to/, "Adding to");
        const el = root.querySelector(".busy-sub");
        if (el) el.textContent = w.addingText;
      },
      { kind: w.source.key, title: w.source.logText },
      (record) => w.records.push(record)
    );
  } catch (err) {
    w.results = w.results || [];
    w.fatal = err;
  }
  invalidateLibrary();
  go("done");
}

function adding() {
  return h("div", { class: "busy-screen" }, h("div", { class: "spinner large" }), h("h2", {}, "Adding your songs to YouTube Music…"), h("p", { class: "muted busy-sub" }, w.addingText), h("p", { class: "muted small" }, "Please keep this tab and the YouTube Music tab open until it's finished."));
}

function done() {
  const r = { added: 0, already_present: 0, duplicate: 0, error: 0 };
  for (const x of w.results || []) r[x.outcome] = (r[x.outcome] || 0) + 1;
  const failed = w.fatal || r.error > 0;

  const undoAll = async () => {
    const ok = await confirmDialog({
      title: "Undo this import?",
      message: "Everything this import added will be taken out again, and any playlist it created will be deleted.",
      confirmText: "Undo the import",
      danger: true,
    });
    if (!ok) return;
    try {
      for (const rec of [...w.records].reverse()) if (!rec.undone) await performUndo(client, rec);
      invalidateLibrary();
      toast("The import has been undone.", { tone: "success" });
      w = freshState();
      render();
    } catch (err) {
      errorDialog(err, { title: "Couldn't undo everything" });
    }
  };

  return h(
    "div",
    { class: "done-screen" },
    h("div", { class: `done-icon tone-${failed ? "warn" : "success"}` }, icon(failed ? "alert" : "checkCircle")),
    h("h2", {}, failed ? "Finished, with some problems" : "All done!"),
    h("p", { class: "lead" }, r.added ? `${plural(r.added, "song")} ${r.added === 1 ? "was" : "were"} added to your YouTube Music.` : "No new songs were added."),
    h(
      "ul",
      { class: "done-list" },
      r.already_present ? h("li", {}, `${plural(r.already_present, "song")} ${r.already_present === 1 ? "was" : "were"} already there, so we skipped ${r.already_present === 1 ? "it" : "them"}.`) : null,
      r.duplicate ? h("li", {}, `${plural(r.duplicate, "song")} appeared twice in your selection and ${r.duplicate === 1 ? "was" : "were"} only added once.`) : null,
      r.error ? h("li", { class: "danger" }, `${plural(r.error, "song")} couldn't be added because of an error. Running the import again will try them again (and skip the ones already added).`) : null,
      w.fatal ? h("li", { class: "danger" }, `The import stopped early: ${w.fatal.message || w.fatal}`) : null
    ),
    h(
      "div",
      { class: "done-actions" },
      button("Open YouTube Music", { kind: "primary", iconName: "external", onClick: () => chrome.tabs.create({ url: w.mode === "liked" ? "https://music.youtube.com/playlist?list=LM" : "https://music.youtube.com/library/playlists" }) }),
      button("See it in My music", { kind: "secondary", iconName: "music", onClick: () => onNavigate("library") }),
      button("Bring in more songs", { kind: "ghost", iconName: "plus", onClick: () => ((w = freshState()), render()) })
    ),
    w.records.length ? h("p", { class: "muted small" }, "Changed your mind? ", button("Undo this import", { kind: "ghost", size: "sm", iconName: "undo", onClick: undoAll }), " — or later, from History.") : null
  );
}

