# EXTENSION_SPEC — YouTube Music Manager & Migrator (Browser Extension)

**Read this entire file before writing any code.** It is the implementation contract, and it is self-contained: you do not need any prior conversation. Where it references the existing repo, those files are on disk in this folder and you should read them as the proven reference implementation — you are *porting* debugged logic, not rediscovering it.

**You are:** the implementing developer (Claude Sonnet 5) in a Claude Code session on a Windows PC.
**The operator:** the person running you. They are **not a developer** — explain plainly, do the technical work yourself, and only ask them to do things a human must do (logins). Python is installed. They can copy/paste and follow clear steps.

**Prior art in this folder (READ THESE):**
- `engine/matcher.py`, `engine/writer.py`, `engine/ledger.py`, `schema.py` — the working, real-account-proven desktop tool. The matching algorithm, thresholds, normalization, dedup, and undo logic are all here and correct. Port them, don't reinvent them.
- `PROGRESS_REPORT.md` — build history. **§2.1** has the discovered JioSaavn endpoints; **§2.2** the HTML-entity lesson; **§2.4** the CAPTCHA/auth findings; **§2.6/§3** YT auth session issues. Load-bearing context.

---

## 0. What this is

A **browser extension** (Chrome, Manifest V3, written portably) that is two tools sharing one engine:

1. **A YouTube Music manager** — see every playlist and Liked Songs with counts; open any collection; sort by title / artist / album / duration / date-added; filter; select tracks; **remove** them, **move** them between collections, and **un-like**; with a full **action log** and **one-click undo** of any action.
2. **A migrator** — detect the user's liked songs and playlists on **JioSaavn** and **Amazon Music**, let them import everything, whole collections, or hand-picked individual tracks (with the same sort/filter/select UI), into YouTube Music as either Liked Songs, one new playlist, or mirrored playlists.

**Hard constraints (do not violate):**
- **No AI / no LLM calls at runtime.** Matching is deterministic string+duration logic (ported from `engine/matcher.py`). Zero token cost when the tool runs.
- **No backend, no server, no hosting, no paid services.** Everything runs client-side in the user's own browser using their own already-logged-in sessions.
- **No caps.** Handle libraries of thousands of tracks.
- **Works for anyone**, because it uses the user's existing browser sessions — no automated logins (this is *why* it's an extension; see §2).
- **Spotify is out of scope.** Do not build it.
- **Destructive by nature.** Removing/moving/un-liking is core. Every destructive action MUST be logged and reversible (§8). This is non-negotiable.

---

## 2. The proven foundation — YouTube Music auth from in-browser JavaScript

**This was empirically verified on a real account. Build on it exactly.** All YouTube Music reads and writes use YT Music's own internal `youtubei/v1` API with a client-computed `SAPISIDHASH` — the same mechanism Google's own web pages use. It is a public, documented pattern, not a security bypass.

### 2.1 The single most important architectural rule
**All YouTube Music reads and writes MUST execute in the page context (MAIN world) of an open `music.youtube.com` tab.** This makes every call *same-origin* (page on `music.youtube.com` → `music.youtube.com/youtubei/v1/...`), which means **no CORS, no preflight, no anti-CSRF token needed** — all verified. It also gives access to the page's own `ytcfg` config object. Calling these endpoints from the extension's background service worker or popup (a different origin) will fail. The manager UI runs in its own extension page and talks to a **MAIN-world injected script** on the YT Music tab via message passing; that injected script performs the actual API calls. Confirm the correct MV3 injection mechanism against current MV3 docs (`world: "MAIN"` content script or injected page script).

### 2.2 The working request shape (reference — port this precisely)
- **Auth header:** `Authorization: SAPISIDHASH {unix_timestamp}_{sha1_hex}` where `sha1_hex = SHA1("{timestamp} {sapisid} {origin}")`, computed fresh per request via `crypto.subtle.digest('SHA-1', ...)`.
- **SAPISID:** read from the `__Secure-3PAPISID` cookie via `document.cookie` (deliberately not httpOnly; Google's own clients read it for this). No other cookie is read manually.
- **Origin:** the literal string `https://music.youtube.com`.
- **Base URL:** `https://music.youtube.com/youtubei/v1/{endpoint}?alt=json&key={INNERTUBE_API_KEY}` — API key is not a secret; read it live via `ytcfg.get('INNERTUBE_API_KEY')`.
- **`context` object:** do NOT hand-construct — read it via `ytcfg.get('INNERTUBE_CONTEXT')`, already correctly shaped by the page.
- **Explicit headers:** `Authorization`, `X-Origin: https://music.youtube.com`, `X-Goog-Visitor-Id` (from `ytcfg.get('VISITOR_DATA')`), `Content-Type: application/json`. Everything else (User-Agent, cookies) is attached automatically by the browser via `credentials: 'include'` on `fetch()`. `X-Goog-AuthUser` was not required for a single signed-in account (see §11 note for multi-account).
- **Endpoints verified:** `browse` (body `{context, browseId}`; `browseId: "VLLM"` = Liked Songs), `search` (body `{context, query, params}` where `params` is the songs-filter token), `like/like` and `like/removelike` (body `{context, target: {videoId}}`). For **playlist create / add items / remove items / delete**, read the exact endpoint + body shapes from `ytmusicapi`'s source (the desktop tool used it; the same mutations exist — `playlist/create`, `browse/edit_playlist` with add/remove actions, playlist delete). Port those shapes the same way.

### 2.3 Security (MANDATORY)
- **Never log, display, persist, or transmit the computed `SAPISIDHASH` value or the `__Secure-3PAPISID` cookie.** It is a live credential. (During the spike, echoing it once tripped a safety filter — that is the signal: it must never leave the page context.) No `console.log` of the auth header, ever, including in shipped code.
- The extension needs **none** of the desktop tool's secret files (`browser.json`, `data/cookie.txt`, `data/curl.txt`). It uses the live browser session. Never read, bundle, or reference those files.

---

## 3. Architecture (MV3)

```
extension/
  manifest.json                  # MV3; host_permissions for the 4 domains; declares the UI page + injected scripts
  src/
    ytmusic/
      inject.js                  # MAIN-world script on music.youtube.com: SAPISIDHASH auth + all youtubei/v1 reads/writes
      bridge.js                  # content-script relay: postMessage between UI page and inject.js
    sources/
      jiosaavn.js                # runs on jiosaavn.com: the §2.1 PROGRESS_REPORT endpoints (same-origin, uses live session)
      amazon.js                  # Phase 3 (discovery needed)
    engine/
      matcher.js                 # PORT of engine/matcher.py (deterministic; no AI)
      normalize.js               # PORT of schema.py normalize_* + version_tag + html-entity decode
      reconcile.js               # read-after-write reconciliation + page-to-exhaustion helpers (§6)
    ui/                          # the manager + importer UI (its own extension page/tab)
      ...                        # modern lightweight framework OK (Svelte/React); lists MUST be virtualized (§7)
    storage/
      log.js                     # action log + undo (IndexedDB; ports engine/ledger.py semantics)
  README.md, LICENSE             # created during the GitHub step (§13)
```

Keep the extension in its **own `extension/` subfolder**, entirely separate from the reference Python (`engine/`, `schema.py`, etc.), which stays intact as reference. **Port, do not mutate** the Python.

**Permissions:** `host_permissions` for `https://music.youtube.com/*`, `https://www.jiosaavn.com/*`, `https://*.jiosaavn.com/*`, and Amazon Music domains (`https://music.amazon.in/*` and the generic `https://music.amazon.*/*` for other regions, since this must work for anyone). Request the minimum; no broad `<all_urls>`.

---

## 4. Phasing & gates

Build in this order. Each phase must pass its §14 acceptance criteria before the next.

- **Phase 0 — Auth foundation module.** Implement `ytmusic/inject.js` + `bridge.js`: SAPISIDHASH auth, and a smoke test that (a) reads Liked Songs (`browse VLLM`) and (b) likes then un-likes one well-known throwaway track, from the real account, confirming 200s. This is already manually proven (§2) — you are committing it as reusable code and proving the *code* path. **Nothing else is built until this passes.**
- **Phase 1 — Manager core (YT Music only).** List all playlists + Liked Songs with counts; open a collection; sort; filter; multi-select; remove-from-playlist; un-like; move between collections; the action log; and **undo**. This touches only YouTube Music (fully proven auth) and is where destructive-safety matters most. Ship this first — it's immediately useful (it's how the operator will clean up an over-import).
- **Phase 2 — Importer (JioSaavn).** JioSaavn extraction (§10) + matcher port (§9) + the three destination modes, feeding matched tracks into the manager. JioSaavn endpoints are already discovered (§10.1).
- **Phase 3 — Amazon source.** Extraction from `music.amazon.*`. Endpoints are **not** yet discovered — this needs a live discovery handoff with the operator (§15).
- **Phase 4 — Power features.** Duplicate finder, group-by-artist / collapse-by-album with bulk select (import *and* manage side), one-click CSV backup before bulk removal, surfacing match buckets in the import UI (§7).

---

## 6. YouTube Music module behavior (`ytmusic/inject.js`, `reconcile.js`)

**Reads:** list playlists (+ counts), list Liked Songs (+ count), fetch a collection's full track list (each with `videoId`, title, artists, album, duration). **Writes:** like, un-like, create playlist, add items, remove items, delete playlist.

Two real-account findings that MUST shape this module (verified during testing):

1. **Read-after-write is briefly inconsistent.** Immediately after a write, a fresh read of the same collection can return a slightly stale count/set for a few seconds before settling (observed as a 340-vs-343 flicker that then stabilized byte-identical). This is eventually-consistent propagation, not data loss — but this tool reads state right after writing it, so **implement read-after-write reconciliation:** keep a local record of what you just wrote and trust that over an immediate fetch for a short window, rather than assuming a fresh read reflects your own just-made change. Do not gate UI correctness on an instant re-read.
2. **Never trust a single fetch for completeness or size.** `limit` is not honored precisely (a `limit=50` call returned 200). Always **page to true exhaustion and de-duplicate by videoId**; derive counts from the de-duped set, not from any single response. This pairs with the JioSaavn count-drift tolerance (§10.1).

---

## 7. Manager features (Phase 1 core + Phase 4 power)

**Core (Phase 1):** For playlists and Liked Songs: show all with counts; open one; **sort** by title / artist / album / duration / date-added (in-memory sort of the fetched list — any sort is fine); **filter/search**; **multi-select** via checkboxes; **remove** selected from a playlist; **un-like** selected from Liked Songs; **move** selected between collections (implemented as add-to-destination then remove-from-source, both via §6 writes). **Lists MUST be virtualized** (render only on-screen rows) so sorting/selecting stays smooth across thousands of tracks. Follow the `frontend-design` skill for a genuinely polished, uncluttered UI — the operator specifically wants this to look good.

**Power (Phase 4):**
- **Duplicate finder** — flag the same track appearing multiple times within a collection or across Liked (directly addresses the "too many of one artist after a messy import" problem).
- **Group-by-artist / collapse-by-album + bulk select** — "select all by this artist" / "select this whole album" in one action, on both the manage side (clean up) and the import side (reveal whole albums hiding inside a source playlist *before* importing). This is the root-cause fix for over-import.
- **One-click CSV backup/export** of a playlist or Liked Songs before any bulk removal — a cheap safety net independent of undo.
- **Surface match buckets** (auto / review / not-found) in the import UI so users see what will and won't come across before committing.

---

## 8. Action log + undo (destructive safety — MANDATORY)

Port the semantics of `engine/ledger.py`, backed by **IndexedDB** (not `chrome.storage.local`, which is too small for large logs).

- **Log every action** (import, remove, move, un-like, playlist create/delete) as a reversible unit with: action type, affected tracks (videoIds + display info), source/destination collection(s), timestamp, and a unique `action_id`. Show this as a human-readable history in the UI.
- **Undo any action** using the reversal primitives **proven on the real account:** un-like via `like/removelike`; remove added playlist items; delete a playlist *if this action created it*; and re-add for reversals of removals/moves.
- **Undo restores membership, not position.** Re-adding a track appends it to the end — YT Music has no clean arbitrary-position insert. **State this plainly in the UI** wherever undo is offered, so users aren't surprised.
- Undo must be safe under the §6 reconciliation rules (don't misjudge success from a stale immediate read).

---

## 9. Importer & matching (`engine/matcher.js`, `normalize.js`)

**Port `engine/matcher.py` faithfully — it is real-account-proven.** Deterministic, no AI:
- Normalize title/artist: lowercase, Unicode NFKC, strip bracketed qualifiers (`[Explicit]`, `(Remastered 2011)`, …), strip `feat./ft.` tails, collapse punctuation/space. Keep originals for display.
- **Decode HTML entities** (`&quot;` etc.) on title/artists/album *at extraction time* — 97/792 JioSaavn rows needed this and it broke matching when missed (PROGRESS_REPORT §2.2). Use the JS equivalent of `html.unescape`. Apply to Amazon too.
- Search YT Music (songs filter). Score = `0.50*title + 0.35*artist + 0.15*duration`, `+5` if result is a song (not a video). Title/artist use a **token-set-ratio** fuzzy match replicating rapidfuzz's `token_set_ratio` semantics (not plain Levenshtein). Duration: 100 within ±3s, decaying to 0 by ±15s; neutral 70 if unknown.
- Buckets: `combined ≥ 85 AND artist ≥ 70` → **AUTO**; `70–85` → **REVIEW**; else / no result / only a different version → **NOT_FOUND** (with `version_tag`).
- **Regional-script mismatches route to REVIEW, never silent auto-match** (e.g. an artist stored in katakana vs Latin). This is correct behavior, verified in the real migration — do not "fix" it by loosening thresholds.

**Three destination modes** (user picks per import): **(A) Like all** into Liked Songs; **(B) Single playlist** (create or reuse-and-append a named playlist); **(C) Mirror** (each source playlist → a same-named YT playlist, reuse-and-append if it exists; the source Liked collection → Liked Songs). Dedup against existing YT state and the action log; AUTO acts, REVIEW/NOT_FOUND are only logged for the user to handle.

---

## 10. Source extractors

Because the extension runs inside the user's **already-logged-in** browser tab, there is **no automated login and therefore no CAPTCHA wall** — this is the clean, permanent version of what the desktop tool could only do with a live assisted browser (PROGRESS_REPORT §2.4). The source scripts make **same-origin** calls from the source tab, so the session cookies attach automatically via `credentials: 'include'`.

### 10.1 JioSaavn (Phase 2 — endpoints already discovered; also in PROGRESS_REPORT §2.1)
- **Liked songs:** `GET /api.php?__call=library.getAll&api_version=4&_format=json&_marker=0&ctx=web6dot0` → `{"song":[ids...], "show":[...], "album":[...]}`. **Read only the `"song"` key** — podcasts/shows live under `"show"`, so this excludes non-music for free.
- **Playlists:** `GET /api.php?__call=playlist.list&all_playlists=true&contents=1&onlypids=true&...` → every playlist's metadata + full track-ID list inline (`more_info.contents`, comma-separated).
- **Hydrate IDs → metadata:** `GET /api.php?__call=library.getDetails&entity_type=song&entity_ids=<up to 50 ids>&...&n=50` → title, `more_info.artistMap.{primary_artists,featured_artists}[].name`, `more_info.album`, `more_info.duration`. **Batch in groups of 50 IDs.**
- Apply **HTML-entity decoding** (§9). Apply **count-drift tolerance of ±5**: small gaps between the ID list and successfully-hydrated tracks (duplicate IDs, region-locked/unhydratable tracks) print a warning and proceed; larger gaps hard-fail as a real capture bug. Map to the same `Song` shape the matcher expects (see `schema.py`: source, collection_type, collection_name, title, artists, album, duration_sec, version_tag).

### 10.2 Amazon Music (Phase 3 — needs discovery, §15)
Same pattern against `music.amazon.*` from the logged-in tab: find the internal endpoints for Library → Songs (the "recently/added" view) and playlists, run them same-origin. Likely needs HTML-entity decoding too. Endpoints are undocumented — **do the discovery with the operator (§15)** rather than guessing. Keep selectors/endpoints in clearly-marked constants.

---

## 11. Edge cases (consolidated — MUST handle)
Read-after-write staleness (§6.1); single-fetch incompleteness / `limit` not honored (§6.2); HTML entities (§9); regional-script → REVIEW (§9); same track across collections / re-runs → dedup + `already_present`/`duplicate`; already-liked / already-in-playlist → skip; only-a-video result → allowed, flagged; same-named playlist exists → reuse-and-append, never duplicate; session/tab not logged in → detect and prompt the user to log into that tab (no automation); unicode/emoji titles; undo restores membership not position (§8); multi-account — if the wrong account's data appears, the YT tab is signed into a different account than expected; surface this rather than guessing (`X-Goog-AuthUser` was unneeded for single-account but note the multi-account case).

---

## 12. Security requirements (MANDATORY — recap)
- Never log/display/persist the `SAPISIDHASH` or `__Secure-3PAPISID` (§2.3).
- Never read, bundle, or commit the desktop tool's secret files (`browser.json`, `data/cookie.txt`, `data/curl.txt`). The extension doesn't need them.
- All privileged calls run same-origin in the target tab's page context (§2.1).
- Ship no telemetry, no external calls, no analytics. Everything stays on the user's machine.

---

## 13. GitHub — publish the code (the operator has never used GitHub; you drive it)

**The operator does not know Git or GitHub. You will do all of it, explain each step in one plain sentence as you go, and ask them to do only the one thing a human must: authenticate their own machine once.** Never ask them to run raw Git plumbing they don't understand, and never put their GitHub password or any token into a command, a file, or the chat.

**Order of operations:**

1. **Secrets-safe `.gitignore` as the very first commit, before anything else is committed.** This is the single most important step. A public repo that ever contains a live session cookie exposes the user's account, and Git history remembers a file even after it's deleted. The `.gitignore` MUST cover: `browser.json`, `data/cookie.txt`, `data/curl.txt`, the entire `data/` runtime folder, `node_modules/`, build output, and anything else secret. Commit `.gitignore` (and a placeholder README) **first**, then verify with `git status` that nothing sensitive is staged.
2. **One-time human auth — walk the operator through it, plainly.** Tell them: install the GitHub CLI (`gh`) from the official page, then run `gh auth login` and choose **GitHub.com → HTTPS → "Login with a web browser"**, which opens their browser to approve. That's the whole human step. Wait for them to confirm it succeeded. (Explain: this proves their computer to GitHub so pushes are allowed; the credential is stored by `gh`, and you — Claude — never see or handle it.)
3. **Create the repo and push, professionally.** Use `gh repo create` to make the GitHub repository, then push. Write a clean commit history with meaningful messages, a proper `README.md` (what the tool is, install-as-unpacked-extension instructions, the honest caveats: it uses the user's own sessions, it's against the platforms' ToS as a scraping tool, it can break when a platform changes), and a `LICENSE` (suggest MIT; confirm with the operator). Put the extension in its own `extension/` subfolder so the public repo shows the extension cleanly.
4. **Professional flow, but you operate it.** Use a feature branch per phase → open a pull request with `gh pr create` → merge. Explain in one sentence what a branch/PR is the first time, but you run every command. The Claude Code desktop app can also monitor PRs and auto-merge.
5. **Before every push, re-verify `git status` shows nothing sensitive.** Make this a habit on each push, not just the first. If a secret was ever committed by mistake, stop and tell the operator immediately — this needs history rewriting and rotating the exposed cookie, not just a delete.

**Do not push to a public repo until the `.gitignore` is confirmed correct and `git status` is clean of secrets.** State that gate out loud when you reach it.

---

## 14. Acceptance criteria per phase
- **Phase 0:** From code (not manual), read Liked Songs and like+un-like a throwaway track on the real account, both 200; auth value never logged.
- **Phase 1:** List all playlists + Liked with correct counts; open, sort (all fields), filter, multi-select; remove / un-like / move all work; every action appears in the log; **undo reverses each primitive on the real account** and the collection returns to its prior membership (position caveat noted in UI). Lists stay smooth at thousands of rows.
- **Phase 2:** JioSaavn liked + playlists extracted (counts within ±5), HTML entities decoded, matched into the three modes correctly; re-runs idempotent.
- **Phase 3:** Amazon extracted from the logged-in tab after discovery; same matching path.
- **Phase 4:** Duplicate finder, album/artist grouping + bulk select, CSV backup, and bucket-surfacing all functional.
- **GitHub:** repo public, `.gitignore` correct from the first commit, no secret ever committed, clean history, README + LICENSE present.

---

## 15. Discovery handoffs (ask the operator; not in your training data)
- **Amazon endpoints (Phase 3):** have the operator open their logged-in `music.amazon.*` tab → DevTools → Network, open Library → Songs and their playlists, and report the internal requests that fire and a sample response. Build extraction from that (prefer direct API over DOM).
- **Playlist mutation shapes:** confirm the exact `youtubei/v1` playlist create/add/remove/delete bodies from `ytmusicapi`'s source in this environment before relying on them.
- If any source login has expired in the tab, ask the operator to log in normally in that tab — never automate the login.

---

## 16. Out of scope
- **Spotify** — not built (its API caps non-org apps and it isn't needed here).
- **Firefox packaging** — write portably, but target Chrome MV3 first; a Firefox port is a later pass.
- **Extension-store publishing** — GitHub first (source, free). The Chrome Web Store's one-time $5 registration comes later, if ever; unpacked install from GitHub is free in the meantime.

**Build Phase 0, prove it, then proceed phase by phase. Set up the secrets-safe GitHub repo early (right after Phase 0) so work is committed safely as you go. Ask the operator for the Phase 3 discovery when you reach Amazon.**
