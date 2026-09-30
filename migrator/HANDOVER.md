# Handover — liked-music-migrator browser extension

**Last updated:** 2026-09-30
**Written for:** a fresh Claude Code session picking this up with no memory of prior conversations. Read this file fully before doing anything else. It's self-contained.

## What this is

This is a Chrome MV3 browser extension. It manages a YouTube Music library and imports liked songs/playlists into it from JioSaavn and Amazon Music. The full implementation contract is [`EXTENSION_SPEC.md`](EXTENSION_SPEC.md). Read it for the hard constraints (no AI/LLM calls at runtime, no backend, destructive actions must be logged and undoable, etc.) and for the phase plan. This handover says what's actually built and what's still open.

**Repo:** public on GitHub at `venom-abhishek/liked-music-migrator`, MIT licensed. The extension lives in `migrator/extension/`. Everything else under `migrator/` (`engine/`, `schema.py`, etc.) is a reference Python CLI tool that the extension's matching/dedup/undo logic was ported from. It is not being extended, so don't touch it.

**Operator:** not a developer. Explain plainly, do the technical work yourself, and only ask them for things a human must do: logging into a site in a tab, or clicking in the extension's own UI, which automation can't reach (see the tooling caveat below). They are an effective, willing tester of real destructive actions against their real accounts, as long as the risk is bounded: previews before writes, disposable test playlists, undo available. When you need something tested, give exact numbered steps and ask for the literal on-screen text or error. Don't just ask "did it work?".

## Current state

Phases 0–3 are built and merged. A full review pass followed (2026-09-26, branch `claude/intelligent-hypatia-f2yqct`), which fixed the problems listed further down.

- **Phase 0: YouTube Music auth.** `src/ytmusic/inject.js` runs in the MAIN world of a `music.youtube.com` tab so it can read `ytcfg`. It signs requests with `SAPISIDHASH`. `src/ytmusic/bridge.js` relays messages between the extension's UI page and inject.js. Verified live.
- **Phase 1: Manager core.** Files: `src/ui/app.js`, `src/engine/reconcile.js`, `src/storage/log.js`. It lists playlists and Liked Songs, opens a collection in a virtualized track list, and supports sort, filter, multi-select, remove, un-like and move, plus an IndexedDB action log with undo. Verified live at real scale.
- **Phase 2: JioSaavn importer.** Files: `src/sources/jiosaavn.js` and `jiosaavnClient.js`, plus `src/engine/{fuzz,normalize,matcher,jiosaavnExtract,importer}.js`. The matcher is a faithful port of rapidfuzz's `token_set_ratio`. It is now covered by tests against values produced by real rapidfuzz, and they match exactly. Verified live on a real 60-track import.
- **Phase 3: Amazon Music source.** Read [`PHASE3_AMAZON_DISCOVERY.md`](PHASE3_AMAZON_DISCOVERY.md) §0 before touching Amazon code. The extension doesn't call Amazon's API. It patches `fetch`/XHR at `document_start` in the MAIN world and reads the responses to the page's own calls.

## What the 2026-09-26 review pass changed

1. **Amazon capture missed the first batch of tracks.** Recording only started when Capture was clicked, and by then the page had already loaded its first batch. A short playlist would therefore capture nothing. Recording is now always on: responses containing track data are kept from page load, tagged with the page URL, and Capture takes the ones for the current page. The scroller now also handles an inner scrolling panel. Browser-tested with a simulated page, but **not yet on the real Amazon site**.
2. **Write-ahead action log** (`storage/log.js`). A record is written before an action's first API call, and each track's step flag (`unliked`, `removed`, `addedToDest`, `removedFromSource`, `added`) is saved as it succeeds. A failure or closed tab partway through leaves an accurate, undoable record, and undo only reverses flagged steps. Older records, which have no `status` field, are treated as fully complete.
3. **Undo order and safety.** Undo restores before it removes, so a failure can leave a track in two places, never in neither. It keeps its progress so a retry doesn't re-add. Undo never deletes a playlist that holds tracks it didn't put there (this fixed a real data-loss path: create playlist → move into it → undo the create first). Creating a playlist during a Move or Import is now part of that action's own record.
4. **Duplicate copies in a playlist** are no longer collapsed on load (de-dup is by `setVideoId`), so they can be seen and removed. The Phase 4 duplicate finder depends on this.
5. **`browse/edit_playlist` failures** (HTTP 200 with a non-SUCCEEDED `status`) now throw instead of being reported as success. Move skips tracks already in the destination, because YT Music refuses duplicate adds.
6. **Multi-account.** Requests now send `X-Goog-AuthUser` (from `ytcfg` `SESSION_INDEX`) and, for brand accounts, `X-Goog-PageId` (`DELEGATED_SESSION_ID`). Where several matching tabs are open, the most recently used one is picked.
7. **Import preview.** A failed search is retried once and then shown as an error rather than "not found", and searches are spaced 120 ms apart. The mode choice (Like all / Single / Mirror) moved next to the Commit button, because it used to be hidden until JioSaavn was loaded, which made it invisible to Amazon-only users. Amazon imports are now labelled as Amazon. There's a "this is my liked songs" checkbox for Amazon Mirror mode.
8. **Smaller fixes:**
   - Playlist counts over 999 are read correctly.
   - JioSaavn playlists with a `"` in the name are no longer silently dropped.
   - New playlists are sent as `PRIVATE` explicitly (a `null` was going out before).
   - The selection count says how many selected tracks the filter is hiding.
   - The Activity & Undo screen repeats the note that undo restores membership, not position.
   - Move/new-playlist asks for confirmation before creating anything.
9. **Tests.** `migrator/extension/tests/` has 39 Node unit tests covering fuzz, normalize, parsers, reconcile, matcher, Amazon extraction, importer and undo. They have no dependencies and use an in-memory IndexedDB. Run them with `cd migrator/extension && npm test`. They also run in GitHub Actions (`.github/workflows/test.yml`).

## UI overhaul (2026-09-30)

The operator said the old UI was nearly unusable for non-technical people, so the whole UI was rebuilt. The engine, storage and matching code are unchanged apart from two small additions: an `onRecord` callback on `commitImport`, and the empty-artist-name filter in the matcher.

- **Name:** "Music Mover for YouTube Music", with a real toolbar icon (`icons/`). The manifest is at version 0.2.0.
- **Structure** (`src/ui/`):
  - `app.js`: navigation between Home, My music, Bring songs in and History.
  - `library.js`: the manager.
  - `import-wizard.js`: the 5-step import.
  - `history.js`: the history screen.
  - `connection.js`: "is X open / signed in", with one-click fixes that open, focus or reload the tab.
  - `dialogs.js`: in-page confirm/prompt/error dialogs and toasts that replace alert/confirm/prompt, plus `explainError()` for plain-language errors.
  - `dom.js`: helpers. `h()` never parses HTML, so names from any service are safe.
- **New UX features:**
  - Undo button in the toast after every action.
  - Floating action bar for selections, and shift-click range select.
  - CSV "Save a copy" of any list.
  - The import review lets the user tick "Please check" (REVIEW) matches, with a Listen link to verify them. This is a first slice of the Phase 4 "surface match buckets" item.
  - Retry for failed searches, a list of not-found songs that can be saved, a progress bar with a Stop button, and "Undo this import" on the done screen.
  - A warning before closing the tab mid-import.
  - Light and dark themes, a narrow-window layout, keyboard support in dialogs.
- **New page-script actions:**
  - `status` in `ytmusic/inject.js`. It returns booleans only: page ready and signed in, never the cookie.
  - `ping` in `sources/jiosaavn.js`.
  - An older loaded copy answers "Unknown action", which `connection.js` treats as connected.
- **Preview without accounts:** `dev/fake-chrome.js` and `dev/preview.mjs` (see the README "Development" section). Use these to check any UI change before asking the operator.

## Needs a live check by the operator (not verifiable from here)

The fixes above were tested with unit tests and a headless browser that fakes Chrome's extension APIs, but not against the real sites. Ask the operator to reload the extension at `chrome://extensions` and then run these checks:

1. **YT auth still works with the new account headers.** Open the extension's My music tab. The playlists and counts should load as before.
2. **Move + undo** on a disposable playlist. Create two test playlists in YT Music, move 2 tracks between them, check Activity & Undo, then undo. The tracks should go back and the text should match what happened.
3. **Amazon Capture button, end to end.** Loose ends from the previous handover still apply:
   - (a) Open a small playlist in the Amazon tab, reload the tab, click Capture: expect the right track count.
   - (b) Do the same with the biggest playlist or Library → Songs: check the count against Amazon's own count. This is the pagination check that has never been done.
4. **Multi-account** (only if the operator has several Google accounts signed in): use a YT Music tab on the second account and check that the library shown is that account's.

## Not done yet

1. **Phase 4 (power features):** duplicate finder, artist/album grouping with bulk select (manage side and import-preview side), one-click CSV backup before bulk removal, and richer match buckets in the import UI (for example, letting the user accept REVIEW matches). See `EXTENSION_SPEC.md` §7.
2. **UI.** Rebuilt on 2026-09-30 (see above). The operator hasn't seen it on real data yet, so ask for their reactions and keep the language non-technical.
3. **Minor, known:**
   - Undoing a removal of *two copies* of the same song restores one copy. YT refuses duplicate adds unless `dedupeOption` is used, which hasn't been explored.
   - The import's "already present" check also matches on normalized title + artist, so two different songs with identical title and artist would be treated as the same.
   - Unfiltered-search fallback results can include the "Song"/"Video" type label as an extra artist token. This is harmless to scoring because token-set matching ignores it.

## Tooling caveat you will hit immediately

If you use browser automation (Claude-in-Chrome or similar), **`chrome://extensions` and `chrome-extension://*` pages can't be reached by it**. You can't click through the extension's own UI yourself. There are two established workarounds:
- A MAIN-world content script that listens via `window.postMessage` (`ytmusic/inject.js`, `amazon-inject.js`) can be triggered directly from a normal page tab using a JS-execution tool.
- An isolated-world script that listens via `chrome.runtime.onMessage` (`sources/jiosaavn.js`, the `*-bridge.js` files) has no page-reachable entry point. Verify the raw behavior directly, then have the operator click through the real UI.

For local testing without Chrome APIs, serve `migrator/extension/` over HTTP and stub `window.chrome.tabs` in the page. `tests/helpers.js` has response builders that are useful for this. That's how the 2026-09-26 UI smoke test was done.

Editing a **content script** requires reloading the extension at `chrome://extensions`, not just the tab, and then reloading the site's tab. Editing the **UI page's** own files only needs the UI tab reloaded. Editing `manifest.json` needs an extension reload and may re-prompt for permissions.

## Where to look for more detail

- [`EXTENSION_SPEC.md`](EXTENSION_SPEC.md): the full original contract, and the source of truth for what "done" means per phase.
- [`PHASE3_AMAZON_DISCOVERY.md`](PHASE3_AMAZON_DISCOVERY.md): §0 covers how Amazon works now; §1–4 are the original investigation.
- [`../PROGRESS_REPORT.md`](../PROGRESS_REPORT.md): the older Python-CLI-era history, for background only.
- [`../README.md`](../README.md): the user-facing overview, install and test instructions.

## Suggested next step

Get the operator's results for the live checks above first. Fix anything they turn up, then start Phase 4.
