# liked-music-migrator

A browser extension for managing your **YouTube Music** library and migrating
liked songs / playlists into it from other services (**JioSaavn** and
**Amazon Music**) — using your own already-logged-in browser sessions.
No servers, no accounts to create, no paid services, and **no AI/LLM calls at
runtime**: matching is deterministic string+duration logic.

> **Status: Phases 0-3 complete; Phase 4 (power features) next.** The
> manager works for YouTube Music (list, sort/filter/select, remove/un-like/
> move, undo), and both JioSaavn and Amazon Music can be extracted, matched,
> and imported (Like all / single playlist / mirror playlists), with a
> preview step before anything is written and undo after. Amazon import is
> the least battle-tested part (see [Roadmap](#roadmap)). Amazon uses
> response interception rather than calling its API directly — see
> [`migrator/PHASE3_AMAZON_DISCOVERY.md`](migrator/PHASE3_AMAZON_DISCOVERY.md)
> for why. See [Roadmap](#roadmap) below, or the full implementation
> contract at [`migrator/EXTENSION_SPEC.md`](migrator/EXTENSION_SPEC.md).

## What's in this repo

- **`migrator/extension/`** — the browser extension. This is the active,
  user-facing part of the project.
- **`migrator/`** (everything else) — a working Python CLI tool that did an
  earlier, real migration for the author. It's kept as a reference: the
  extension ports its matching/dedup/undo logic (deterministic scoring, no
  AI) rather than reinventing it. It is not the recommended way to use this
  project going forward — the extension is.

## Why an extension, not a script

Automating a login to JioSaavn or Amazon Music runs straight into bot
detection (reCAPTCHA that never even shows a challenge to solve). A browser
extension sidesteps this entirely: it runs inside a tab **you** are already
logged into, using the same internal API calls the site's own pages make, the
same way YouTube Music's own web client authenticates itself. No login is
ever automated by this tool.

## Installing (unpacked, from source)

There's no Chrome Web Store listing yet (that costs a one-time $5 developer
fee; source-only install is free in the meantime). To install:

1. Download this repository (green **Code** button → **Download ZIP**) and
   unzip it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `migrator/extension` folder.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Music Mover**.
6. Click the Music Mover icon. It opens its own tab and tells you, step by
   step, what to open and sign in to.

## Using it

The extension opens as its own tab with four sections:

- **Home**: shows whether YouTube Music is connected (with a one-click fix
  if it isn't) and links to the two main jobs.
- **My music**: your playlists and Liked songs. Open one, search or sort,
  tick songs (shift-click selects a range), then **Move to…**, **Remove**
  or **Un-like** from the bar at the bottom. Every change asks first and
  shows an **Undo** button afterwards. **Save a copy** downloads the list
  as a spreadsheet file.
- **Bring songs in**: a 5-step guide for copying songs from JioSaavn or
  Amazon Music. Nothing is written until the last step. You see which
  songs matched clearly, which need a quick check (with a **Listen**
  button), and which weren't found. You then choose where they go.
- **History**: every change in plain words, each with an **Undo** button.

## Honest caveats

- **This uses your own browser session**, the same way any page you're
  logged into can act on your behalf. It never asks for or stores a
  password, and it never logs the session values it reads.
- **This is a scraping/automation tool against services that don't offer a
  public API for this.** It relies on YouTube Music's, JioSaavn's, and
  Amazon Music's internal, undocumented endpoints. That is very
  likely against those platforms' Terms of Service, even though it only ever
  acts as *you*, using *your* session, doing things you could do by hand in
  the UI.
- **It can break at any time** if a platform changes its internal API shape,
  page structure, or auth mechanism. There is no SLA and no support
  guarantee — this is a personal tool shared as source.
- **Destructive actions are logged and undoable** (Activity & Undo tab). Each
  action is recorded *before* it starts and updated step by step, so even an
  action that fails halfway can be undone for exactly the part that happened.
  Undo restores *membership*, not *position* — an undone removal re-adds a
  track to the end of a playlist, not its original spot — and it never
  deletes a playlist that has tracks in it that it didn't put there.

## Roadmap

Phased build order (each phase gates the next):

1. **Phase 0 — Auth foundation.** ✅ Read Liked Songs, like/un-like a track,
   from real account code (not manual DevTools steps), auth value never
   logged.
2. **Phase 1 — Manager core (YouTube Music only).** ✅ List playlists + Liked
   Songs, sort/filter/select, remove/un-like/move, action log, undo.
3. **Phase 2 — JioSaavn importer.** ✅ Extraction + deterministic matching +
   three import modes (Like all / single playlist / mirrored playlists).
4. **Phase 3 — Amazon Music source.** ✅ (via response interception, not
   direct API calls — see `migrator/PHASE3_AMAZON_DISCOVERY.md`.) Verified
   on a 37-track playlist; paging through a large playlist is implemented
   but not yet verified live.
5. **Phase 4 — Power features.** Duplicate finder, artist/album bulk select,
   CSV backup, match-bucket surfacing.

## Development

The extension has no build step — edit files under `migrator/extension/src/`
and reload it at `chrome://extensions`. Unit tests for the matching,
parsing, Amazon extraction, importer and undo logic run under Node (22+),
with no dependencies to install:

```
cd migrator/extension
npm test
```

They also run automatically on every push and pull request (GitHub Actions).

To preview the UI without any accounts, `dev/fake-chrome.js` stands in for
Chrome's extension APIs and for the three music sites, using realistic fake
data. `dev/preview.mjs` clicks through every screen with it and saves
screenshots (it needs Playwright: `node dev/preview.mjs [outDir]`). Neither
file is used by the extension itself.

## License

[MIT](LICENSE)
