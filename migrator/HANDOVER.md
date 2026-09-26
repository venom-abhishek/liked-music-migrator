# Handover — liked-music-migrator browser extension

**Date:** 2026-09-27
**Written for:** a fresh Claude Code session picking this up with no memory of prior conversations. Read this file fully before doing anything else — it's self-contained.

## What this is

A Chrome MV3 browser extension that manages a YouTube Music library and imports liked songs/playlists into it from JioSaavn and Amazon Music. Full implementation contract: [`migrator/EXTENSION_SPEC.md`](EXTENSION_SPEC.md) — read that for hard constraints (no AI/LLM calls at runtime, no backend, destructive actions must be logged+undoable, etc.) and the original phase plan. This handover tells you what's actually been built against that spec and what's still open; the spec itself hasn't changed.

**Repo:** public on GitHub, `venom-abhishek/liked-music-migrator`, MIT licensed. The extension lives in `migrator/extension/`; everything else under `migrator/` (`engine/`, `schema.py`, etc.) is a reference Python CLI tool the extension ported its matching/dedup/undo logic from — it's not being extended further, don't touch it.

**Operator:** not a developer. Explain plainly, do the technical work yourself, only ask them to do things a human must do (logging into a site in a tab, clicking a button in the actual browser UI that you can't reach yourself — see the tooling caveat below). They are an effective, willing tester of real destructive actions against their real accounts as long as the risk is bounded (previews before writes, disposable test playlists, undo available) — when you need something tested, give exact numbered steps and ask for the literal on-screen text/error, don't just ask "did it work?".

## Current state: Phases 0-3 done and merged to `master`

- **Phase 0 — YouTube Music auth.** `src/ytmusic/inject.js` runs in the MAIN world of a `music.youtube.com` tab (needed to read `ytcfg` — a page-global JS object inaccessible from an isolated content script) and signs requests with `SAPISIDHASH`, the same mechanism YT Music's own web client uses. `src/ytmusic/bridge.js` relays messages between the extension's UI page and inject.js. Verified live: liked-songs read + like/un-like round trip, both 200, on the real account.
- **Phase 1 — Manager core** (`src/ui/app.js`, `src/engine/reconcile.js`, `src/storage/log.js`). Lists playlists + Liked Songs with counts, opens a collection with a virtualized track list (`src/ui/virtual-list.js`), sort/filter/multi-select, remove/un-like/move between collections, an IndexedDB-backed action log with undo. Verified live at real scale (a 348-track Liked Songs list, 11 playlists, a full create→add→remove→undo→delete cycle on a disposable test playlist).
- **Phase 2 — JioSaavn importer** (`src/sources/jiosaavn.js` + `jiosaavnClient.js`, `src/engine/{fuzz,normalize,matcher,jiosaavnExtract,importer}.js`). JioSaavn's API needs no signing, just cookies (a normal isolated-world content script fetch works). The matcher is a faithful port of `rapidfuzz`'s actual `token_set_ratio` algorithm (read from its Python source, not docs) plus `schema.py`'s normalization — with one deliberate fix over a literal port: Python's `\w` is Unicode-aware, JS's isn't, so title/artist normalization uses `\p{L}\p{N}\p{M}` Unicode property escapes instead of `\w`, or it would silently mangle Devanagari/other non-Latin text. Three destination modes (like all / single playlist / mirror playlists), a preview-before-commit UI, dedup against live YT state. Verified live: a real 60-track import (49 added, 8 correctly deduped, 3 flagged for review).
- **Phase 3 — Amazon Music source** (`src/sources/amazon-inject.js` + `amazon-bridge.js` + `amazonClient.js`, `src/engine/amazonExtract.js`). **This one has a real story — read [`migrator/PHASE3_AMAZON_DISCOVERY.md`](PHASE3_AMAZON_DISCOVERY.md) before touching Amazon code.** Short version: Amazon's internal "Skyfire" API can't be called directly from an extension — it validates each call against server-side session state built by a *preceding sequence* of calls (`elementClicked → showLibraryPlaylist → onInteraction`), not just per-request auth fields, so a from-scratch request can never look genuine no matter how correctly its headers/tokens are constructed (this was tried extensively and abandoned on the spec author's explicit direction). The working approach instead: a MAIN-world content script patches `fetch`/`XMLHttpRequest` **at `document_start`** — before Amazon's own bundle initializes and captures a private reference to the native functions — and reads the *responses* to the page's own real, already-authenticated calls as the operator (or an auto-scroll) browses their library. Verified live: the timing patch does win the race (real Skyfire calls get captured), and extracted title/artist/album/duration for a full playlist matched the on-screen list exactly. Field mapping in the Skyfire response tree (`secondaryText1/2/3` = artist/album/duration, track id comes from the row's `primaryLink.deeplink` `trackAsin` query param, not the row's own `id`) is confirmed against real data.

## What's NOT done / open loose ends

1. **Amazon auto-scroll pagination is implemented but unverified for large playlists.** The account used for testing only had a 37-track playlist as its biggest, which loaded in a single response — the scroll-and-detect-stability loop in `autoScrollAndCapture()` (`src/engine/amazonExtract.js`) was never exercised against a playlist actually requiring multiple continuation fetches. If you're debugging an Amazon import that seems to be missing tracks on a big playlist, this is the first place to look.
2. **The Amazon "Capture current Amazon page" button has never been clicked through in the real extension UI by anyone.** All Amazon verification was done by driving the underlying content-script message protocol directly (see the tooling caveat below) — the actual button click → `runAmazonCapture()` → UI update path in `src/ui/app.js` is code-reviewed but not click-tested.
3. **Phase 4 (power features) hasn't been started:** duplicate finder, artist/album grouping with bulk select (both on the manage side and the import-preview side), one-click CSV backup before bulk removal, surfacing match buckets more richly in the import UI. See `EXTENSION_SPEC.md` §7 "Power (Phase 4)".
4. **The operator has said they want a visually better UI eventually.** Current UI is functional/plain by design (moving fast through phases) — treat this as a real future ask when Phase 4 or later work touches the UI, not just an offhand comment.

## Tooling caveat you will hit immediately

If you're using browser automation (Claude-in-Chrome or similar) to verify anything: **`chrome://extensions` and `chrome-extension://*` pages cannot be reached by that automation** — navigating to them fails. You cannot click through the extension's own popup/manager UI yourself. Two established workarounds:
- For a MAIN-world content script that listens via `window.postMessage` (`ytmusic/inject.js`, `amazon-inject.js`), you can trigger it directly from a normal page tab via a JS-execution tool, since that runs in the same MAIN world — this is how Phases 0, 1, and 3 got verified without ever opening the extension UI.
- For an isolated-world content script that only listens via `chrome.runtime.onMessage` (`sources/jiosaavn.js`, and the `*-bridge.js` files' `chrome.runtime` side), there's no page-reachable entry point — verify the underlying raw behavior directly (e.g. a same-origin `fetch()` from the page), then have the operator click through the actual extension UI once for final wiring confirmation.

Also: editing a **content script** file needs the extension itself reloaded at `chrome://extensions` (not just the tab) before changes take effect — ask the operator to click the reload icon there. Editing the **UI page's** own JS/CSS/HTML only needs the UI tab reloaded. Editing `manifest.json` needs an extension reload and may re-prompt for permissions.

## Where to look for more detail

- [`migrator/EXTENSION_SPEC.md`](EXTENSION_SPEC.md) — the full original contract, still the source of truth for what "done" means per phase.
- [`migrator/PHASE3_AMAZON_DISCOVERY.md`](PHASE3_AMAZON_DISCOVERY.md) — the complete Amazon investigation, useful if Amazon breaks or needs extending (e.g. a "Songs" library view beyond playlists).
- [`PROGRESS_REPORT.md`](../PROGRESS_REPORT.md) — the older Python-CLI-era history, background only.
- [`README.md`](../README.md) — user-facing overview and install instructions, kept in sync with phase status.

## Suggested next step

Either: (a) close the two Amazon loose ends above before considering Phase 3 fully solid, or (b) start Phase 4. Ask the operator which they'd rather do — don't assume.
