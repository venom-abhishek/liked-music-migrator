# Liked Music Migrator — Progress Report

**As of:** 2026-08-18
**Repo:** `Z:\liked-music-migrator\migrator\`
**Spec:** `BUILD_SPEC.md` (provided 2026-08-16), phase-gated: Phase 0 (engine) → Phase 1 (JioSaavn) → Phase 2 (Amazon, stub) → Spotify (out of scope, stub)

This report is a factual account of what was built, what was tested, and every issue hit along the way with how it was actually resolved. It's written for whoever updates BUILD_SPEC.md next, particularly for planning the Amazon Music extractor and any "standalone extension" work.

---

## 0. Note for the lead (read this first)

The operator (you're getting this report from them, not from the Sonnet 5 session that did the work) now has new ideas about the "standalone extension" approach — specifically around how extraction/auth should work going forward, informed by everything in §2.4–2.6 and §4 below. Those ideas are **not yet captured anywhere in this document** — the operator wants to talk them through with you before anything is finalized.

Requested next steps, in order:
1. Read this report to get up to speed on everything actually built, tested, and hit so far (Phase 0 engine, Phase 1 JioSaavn extractor, the real migration that was run, and every bug/obstacle along the way).
2. **Ask the operator what their new ideas for the standalone extension are** — don't assume or infer them from this report.
3. Evaluate those ideas against what's actually been learned here (particularly: what worked, what didn't, and why — the CAPTCHA/auth findings in §2.4 and §3 are load-bearing for that evaluation).
4. Write an updated spec reflecting whatever you and the operator land on, structured so it can be handed to a **fresh** Claude Code Sonnet 5 session (no memory of this conversation) to actually build from.

---

## 1. Phase 0 — Engine (COMPLETE)

Built exactly per spec §2 repo layout: `schema.py`, `engine/{matcher,writer,ledger,importer,ytm_auth}.py`, `run.py`, `config.yaml`, `requirements.txt`, `extractors/base.py`. ~1,900 lines total across the engine + CLI (extractors counted separately below).

**Validation happened in two stages:**

1. **Fake-client stage.** Before real YT Music auth existed, a stateful fake `YTMusic` client was written (scratchpad only, not committed) simulating `search`/`get_liked_songs`/`get_library_playlists`/`get_playlist`/`rate_song`/`create_playlist`/`add_playlist_items`/`remove_playlist_items`/`delete_playlist`. The real engine code was run against it for every §11 acceptance criterion: dry-run zero-write, Mode A/B/C `--commit` with correct `already_present`/`not_found`/`review` routing, idempotent re-runs, `undo`, and safety on unicode/emoji/blank-duration/zero-result inputs. All passed.

2. **Real-account stage.** Once YT Music auth was working (see §3 below for how that was hard), the operator ran `setup-ytm`, then Mode A dry-run and `--commit` against `data/sample_test.csv` on their **actual** YT Music account: 7 real AUTO likes were written, 2 correctly skipped as `already_present` (real pre-existing overlap in their library), 1 correctly `not_found`, matching the dry-run's plan exactly. The operator chose to keep the 7 test likes rather than run `undo`. Modes B and C were **not** independently re-verified against the real account — they only change destination routing, not matching/writing logic, and were already exhaustively covered by the fake-client tests. `undo` was likewise only exercised against the fake client, not the real account.

**Environment note:** this machine runs Python 3.14. `pyyaml==6.0.2` (spec's original pin) has no prebuilt wheel for cp314 and fails to build without MSVC Build Tools. Repinned to `pyyaml==6.0.3`.

---

## 2. Phase 1 — JioSaavn Extractor (COMPLETE for this operator's account)

### 2.1 Discovery

BUILD_SPEC §12 assumed JioSaavn's liked-songs/playlist lists would need the §6 tiered strategy (network JSON capture → direct paginated calls → DOM scroll-scraping fallback) because of list virtualization. Live discovery against the operator's real, logged-in JioSaavn session found this wasn't necessary:

- **Liked songs:** `GET /api.php?__call=library.getAll&api_version=4&_format=json&_marker=0&ctx=web6dot0` returns `{"song": [id, id, ...], "show": [...], "album": [...], ...}` — the **complete** liked-songs ID list in one unpaginated call. Podcast/show items live in a separate `"show"` key entirely, so reading only `"song"` already excludes them (spec §10.13's non-music filtering requirement turned out to be free).
- **Playlists:** `GET /api.php?__call=playlist.list&all_playlists=true&contents=1&onlypids=true&...` returns every playlist's metadata **and full track-ID list** inline (`more_info.contents`, comma-separated), also in one unpaginated call.
- **Hydration:** `GET /api.php?__call=library.getDetails&entity_type=song&entity_ids=<up to ~50 ids>&...&n=50` turns IDs into full metadata (title, `more_info.artistMap.{primary_artists,featured_artists}[].name`, `more_info.album`, `more_info.duration`). Called in batches of 50 IDs — this is ID-batching, not true offset/cursor pagination.

No DOM scraping (spec §6 Tier 3) was implemented or needed for JioSaavn. This is a real deviation from the spec's anticipated architecture, made because discovery revealed a simpler path was available — worth deciding explicitly whether Amazon gets the same "try Tier 2 directly first" treatment or whether Tier 3 DOM fallback should be built preemptively for it.

**Count-verification calibration:** the spec's §6 safeguard as written ("assert captured-unique == stated total... fail loudly on mismatch") was found to be too strict in practice — the real account showed a persistent small drift (e.g., 402 vs 403 vs 405 across different countings, from raw-ID duplicates and a couple of tracks that fail to hydrate, likely unavailable/region-locked). Implemented `COUNT_DRIFT_TOLERANCE = 5`: gaps within tolerance print a warning and proceed; larger gaps hard-fail (`CountMismatchError`) since that would indicate an actual capture bug rather than benign real-world messiness.

### 2.2 A bug found and fixed: HTML entities

JioSaavn's API returns HTML-entity-escaped text in some titles (e.g. `I Want Love (From &quot;Rocketman&quot;)`). The first extraction pass didn't decode this, which degraded fuzzy-match scores broadly and caused 4 tracks to fail matching entirely (searches literally included `&quot;` garbage). Fixed by adding `html.unescape()` to title/artists/album in `_to_song()`. Re-running the matcher after cleaning the existing CSV (no re-extraction needed) dropped `NOT_FOUND` from 4 to 0 and improved several `REVIEW` cases into `AUTO`. **97 of 792 rows** had HTML entities that needed cleaning. This should be built into the extractor from the start for Amazon too, if Amazon's API/DOM has similar escaping.

### 2.3 A bug found and fixed: ledger dedup check was silently broken

`engine/ledger.py`'s `is_duplicate()` compared a normalized key (`Song.key()`, lowercase/stripped) against **raw, un-normalized** stored title/artist text. This meant the cross-run duplicate check almost never actually matched (case differences alone would break it), silently defeating one of the two dedup mechanisms described in spec §8.4 ("skip if... already liked/added in a prior ledger row → duplicate"). It was masked by the *other* dedup mechanism (`already_present`, which checks live YT Music state and was working correctly) — so no incorrect double-writes ever happened, but the ledger-based check was pure dead weight. Fixed by normalizing both sides at comparison time. Verified against the real ledger.

### 2.4 The JioSaavn login CAPTCHA problem (unresolved for full automation)

This was the largest real obstacle and is the most important thing for planning Amazon's extractor and any "standalone" (no-Claude-in-the-loop) tooling.

- JioSaavn's login flow is gated by reCAPTCHA. Playwright's bundled Chromium gets flagged: the "I'm not a robot" checkbox spins and silently resets with **no image challenge ever appearing** — meaning the risk-scoring rejects the automation outright before a human even gets a chance to prove anything.
- Tried `channel="chrome"` (have Playwright drive the operator's real installed Chrome instead of its bundled Chromium build) as a legitimate, standard configuration change. **Did not fix it.** The `page.on(...)`/CDP-based "controlled by automated test software" signal is inherent to any CDP automation regardless of which Chrome binary is driven, not specific to the bundled build.
- **What was explicitly ruled out per hard policy, regardless of framing:** writing any code intended to spoof/evade the bot-detection (fingerprint spoofing, stealth patches, etc.), even for the operator's own account with their own consent. This is a firm line, not a preference.
- **What actually worked:** the operator logged into JioSaavn manually in their **own regular, non-automated Chrome** (mobile OTP flow) — completely unremarkable, no automation involved, CAPTCHA behaved normally. Since a live `claude-in-chrome` MCP connection to that same real browser was available, Claude ran the actual extraction (the Tier-2 API calls from §2.1) directly in that already-authenticated tab via injected JavaScript `fetch()` calls, saved the ~792-record result as a browser-triggered file download (Chrome saved it under a random UUID `.tmp` name rather than the requested filename — worth knowing if this recurs), and converted that JSON into `data/jiosaavn.csv` via `schema.save_songs`.
- **This got the operator's real data extracted today, but it is not a standalone solution** — it required a live AI-driven browser connection, not just the CLI tool running unattended. `extractors/jiosaavn.py`'s own Playwright-driven `inventory()`/`extract()` functions still hit the same CAPTCHA wall on first login and were never actually exercised end-to-end by an unattended run.
- **A durable fix was identified but not yet executed** (queued as the next task): launch the operator's real `chrome.exe` directly (not through Playwright) with `--user-data-dir` pointed at Playwright's own profile folder (`data/jiosaavn_profile`), log in there normally, close it, then Playwright's persistent-context launches should find the session already saved and skip login entirely on future runs — same "human authenticates for real, tool reuses the resulting session" pattern as YT Music's `browser.json`, just bootstrapped once from outside Playwright instead of inside it. **This has not yet been tried or confirmed to work.** If Amazon's login has similar bot-detection (plausible — Amazon is generally aggressive about this), the same bootstrap pattern is the recommended starting point rather than assuming Playwright-driven login will work.

### 2.5 Real migration outcome

Destination: Mode B, single new playlist "All Jio Saavn songs" (operator's choice — wanted everything unified into one playlist for now, explicitly did not want Liked Songs touched, planned to possibly switch to liking everything later).

- 792 total source rows extracted (402 Liked Songs + 11 playlists, after the count-drift-tolerant dedup described in §2.1)
- 792 rows fed into `import --mode B --commit`
- Final: **442 unique tracks added** to the new playlist
- 327→ (varies slightly run-to-run due to search non-determinism) counted as `duplicate` — same track present in multiple JioSaavn collections, correctly added only once
- 6 unique tracks (several appearing more than once across collections) left in `review.csv`, mostly because JioSaavn stored "Martin Garrix" in Japanese katakana (マーティンギャリックス) for some tracks, which naturally string-matches poorly against YouTube's Latin-script "Martin Garrix" — correct behavior per spec §10.7 (regional-script mismatches should route to REVIEW, never silently auto-match), not a bug
- 1 track in `not_found.csv` (a niche cover version, plausibly genuinely absent from YT Music)
- Operator's pre-existing Liked Songs were never modified, as intended by Mode B

**This required 5 separate commit-run attempts to finish**, not because of a design flaw in the resumability logic (which worked exactly as intended — every partial run's progress was preserved and safely resumed) but because of an external constraint:

### 2.6 YT Music auth session lifetime (~1 hour under active use)

Across this migration, the `browser.json` session obtained via the header/cookie-paste method (see §3) reliably stopped working (HTTP 401 on write calls, specifically `add_playlist_items`) after roughly **45–75 minutes of active use** each time, requiring the operator to redo the full DevTools copy-paste re-auth flow. This happened 3 times over the course of committing 792 tracks. Each time, the run stopped gracefully (per spec §8.5/§10.2's auth-error handling), flushed its ledger, and resuming after re-auth correctly picked up exactly where it left off with no duplicate writes and no data loss — but this cost significant operator time and very nearly caused the operator to want to abandon the project (see §4).

**This is a real operational constraint for any large migration** (a full Amazon Music library could easily be in the same 400-800+ track range) and should be planned for explicitly rather than assumed away — e.g., by budgeting for multiple re-auth cycles on large libraries, and/or investigating whether ytmusicapi's OAuth-based auth (a different, longer-lived credential type, though currently harder to set up per ytmusicapi's own docs due to Google restricting the device-code flow) would avoid this.

One transient failure during this stretch was **not** an auth issue: a raw, unhandled `JSONDecodeError` crashed the whole process when a `get_liked_songs` pagination call got a "Remote end closed connection" / empty response. This was a genuine gap — `writer.preload()` wasn't wrapped in the same graceful-stop handling as the per-track loop, so a transient network blip produced a scary raw traceback instead of a clean message. Fixed by wrapping `preload()` in both `run_import` and `run_approved` with a clean try/except that reports the issue and exits cleanly, noting that it's always safe to just re-run since nothing had been written yet at that point.

---

## 3. YT Music Auth Setup (relevant to both phases, already resolved)

Not itself part of Phase 1, but consumed significant time and is worth the planner knowing about since re-auth is now a recurring need (§2.6):

`ytmusicapi`'s browser-header auth requires the operator to paste request headers copied from `music.youtube.com` DevTools. Several methods that are commonly recommended (including in earlier drafts of this project's own approach) turned out not to work on the Chrome version in use (v151):

- Manually copying the pretty-printed "Request Headers" panel text by hand — no reliable raw-text ("view source") toggle was findable in this Chrome version, and hand-selecting the very long Cookie value risked corruption.
- DevTools "Copy as fetch" — Chrome deliberately omits the `Cookie` header from this format (a browser security restriction: JS `fetch()` isn't allowed to set Cookie manually), so this can never work for this use case.
- DevTools "Copy as cURL" (bash or cmd variant) **alone** — confirmed empirically that this Chrome version **also** omits the Cookie header from cURL copy, even though this is not a JS-fetch restriction and cURL copy is commonly assumed to include everything. 34 other headers came through fine every time; Cookie never did.

**Working method, now built into `engine/ytm_auth.py`:** get every other header via "Copy as cURL (bash)" into a file, get *just* the Cookie value via manual selection of that one row in the Headers panel into a second file, then merge them (`run.py setup-ytm --from-curl-file ... --cookie-file ...`). Full detail already captured in this repo's own memory notes; see `data/curl.txt` + `data/cookie.txt` pattern. Both files are gitignored and deleted after use since they contain a raw session cookie in plaintext.

---

## 4. Notable friction / near-abandonment points

Worth being explicit about for planning purposes, since Amazon's extractor will likely hit some of the same shape of problem:

- The YT Music auth setup took **4 consecutive failed attempts** before the working method (§3) was found, each with a different specific cause (missing cookie+authuser header, then just missing cookie, then a saved-file mix-up).
- The JioSaavn CAPTCHA wall (§2.4) led the operator to directly ask whether the project was achievable at all and whether to cancel their subscription. It was resolved by (a) plainly explaining the actual mechanism (automation fingerprinting, not something Claude was doing to obstruct), (b) being explicit and non-negotiable that bot-detection evasion code would not be written regardless of framing, and (c) finding a legitimate mechanism (real-browser login + session reuse) that stayed clearly on the right side of that line rather than a workaround that danced around it.
- Windows `cmd.exe`-specific gotchas cost real time independent of the above: plain `cd` does not change drives (needs `cd /d`), and long single lines pasted into legacy Command Prompt are unreliable (worked around by using Notepad + file-based input instead of direct terminal paste for anything long).

---

## 5. What's explicitly NOT done yet

- `extractors/jiosaavn.py`'s Playwright-driven login has never been exercised successfully end-to-end (see §2.4) — today's real extraction went through a live-browser-assisted path instead. The standalone-profile bootstrap (real `chrome.exe` + `--user-data-dir` pointed at Playwright's profile folder, login once, then hand off to Playwright) is the next planned step to make `python run.py extract jiosaavn` work fully unattended, but is unconfirmed.
- `extractors/amazon.py` is still an empty stub (per spec §13, this was always gated behind Phase 1 working — Phase 1 is now functionally working for data, though not yet for unattended re-runs).
- `extractors/spotify.py` remains an empty stub, out of scope per spec §0/§13.
- Modes B and C's real-account write paths beyond what Mode B's JioSaavn run exercised (Mode A and Mode B are now both real-account-proven; Mode C has only ever been tested against the fake client).
- `undo` has only ever been exercised against the fake client, never against real account state.
