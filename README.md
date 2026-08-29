# liked-music-migrator

A browser extension for managing your **YouTube Music** library and migrating
liked songs / playlists into it from other services (currently **JioSaavn**;
Amazon Music planned) — using your own already-logged-in browser sessions.
No servers, no accounts to create, no paid services, and **no AI/LLM calls at
runtime**: matching is deterministic string+duration logic.

> **Status: Phase 0 only.** The extension currently proves its YouTube Music
> auth foundation (reading Liked Songs, liking/un-liking a track). The
> manager UI, the importer, and Amazon support are not built yet — see
> [Roadmap](#roadmap) below, or the full implementation contract at
> [`migrator/EXTENSION_SPEC.md`](migrator/EXTENSION_SPEC.md).

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

1. Download or `git clone` this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `migrator/extension` folder.
5. Open a tab to `music.youtube.com` and make sure you're logged in there.
6. Click the extension's toolbar icon to open its UI.

## Honest caveats

- **This uses your own browser session**, the same way any page you're
  logged into can act on your behalf. It never asks for or stores a
  password, and it never logs the session values it reads.
- **This is a scraping/automation tool against services that don't offer a
  public API for this.** It relies on YouTube Music's, JioSaavn's, and (once
  built) Amazon Music's internal, undocumented endpoints. That is very
  likely against those platforms' Terms of Service, even though it only ever
  acts as *you*, using *your* session, doing things you could do by hand in
  the UI.
- **It can break at any time** if a platform changes its internal API shape,
  page structure, or auth mechanism. There is no SLA and no support
  guarantee — this is a personal tool shared as source.
- **Destructive actions are logged and undoable** (see the spec's action-log
  design), but undo restores *membership*, not *position* — an undone
  removal re-adds a track to the end of a playlist, not its original spot.

## Roadmap

Phased build order (each phase gates the next):

1. **Phase 0 — Auth foundation.** ✅ Read Liked Songs, like/un-like a track,
   from real account code (not manual DevTools steps), auth value never
   logged.
2. **Phase 1 — Manager core (YouTube Music only).** List playlists + Liked
   Songs, sort/filter/select, remove/un-like/move, action log, undo.
3. **Phase 2 — JioSaavn importer.** Extraction + deterministic matching +
   three import modes (Like all / single playlist / mirrored playlists).
4. **Phase 3 — Amazon Music source.** Needs live endpoint discovery.
5. **Phase 4 — Power features.** Duplicate finder, artist/album bulk select,
   CSV backup, match-bucket surfacing.

## License

[MIT](LICENSE)
