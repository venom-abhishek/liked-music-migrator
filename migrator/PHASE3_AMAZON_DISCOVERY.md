# Phase 3 (Amazon Music) — Discovery Notes and Resolution

**Date:** 2026-08-30
**Written by:** Claude Sonnet 5, in the same Claude Code session that built Phases 0–2 of the browser extension (see `migrator/EXTENSION_SPEC.md` and the repo at `github.com/venom-abhishek/liked-music-migrator`).
**Intended audience:** the project lead who wrote `EXTENSION_SPEC.md` (reviewing this in a Claude Opus 5 session), and the developer who built the original Python JioSaavn extractor (`migrator/extractors/jiosaavn.py`, documented in `PROGRESS_REPORT.md`) — the operator is sharing this same document in both places since each may recognize something the other doesn't.

**Why this exists:** `EXTENSION_SPEC.md` §15 flags Amazon Music as needing a live discovery handoff since its endpoints are undocumented. We did that handoff live with the operator's real, logged-in `music.amazon.in` account. We found the endpoint, the client-side auth mechanism, and the exact request shape a *working* request uses — but a from-scratch reconstruction of that request, matching the working one field-for-field as far as we can observe, still gets rejected by Amazon's backend with a generic, non-diagnostic error. This document is everything confirmed, everything tried, and what to try next, so whoever continues this doesn't start from zero.

> **Status update (2026-09): resolved — by not forging requests at all.** Sections 1–4 below are the
> original discovery log and are kept as-is, because they explain *why* the final design is what it is. The
> blocker in §3 was never cracked; the approach was changed instead. Read §0 first.

---

## 0. Resolution: read the page's own responses instead of making our own requests

**Why the §3 approach can't work.** Amazon's Skyfire API validates each call against server-side session
state that the page builds up through a *preceding sequence* of calls (`elementClicked` →
`showLibraryPlaylist` → `onInteraction`), not just against the per-request fields in §2.3. A request built
from scratch, however exact its fields, arrives with no sequence behind it and gets the generic "Service
error" dialog. This was tried extensively and dropped on the spec author's direction.

**What the extension does instead** (`extension/src/sources/amazon-inject.js`):
- A MAIN-world content script runs at **`document_start`**, which is before Amazon's bundle initializes and
  keeps its own private reference to `fetch`/`XMLHttpRequest`. It wraps both. Patching any later has no
  effect, because the app already holds the original functions. The timing was verified live: real Skyfire
  calls do get captured.
- It only reads **response bodies** from `*.skill.music.a2z.com/api/*`. It never reads request
  bodies/headers, which is where the access token and csrf values live. The extension never makes an Amazon
  request of its own.
- Recording is **always on** from page load. It keeps only responses that contain `trackAsin` (the ones
  that carry track rows), at most 300, each tagged with the page URL (origin + path) it arrived on. The
  Capture button takes the ones for the page currently open. *(An earlier version only started recording
  when Capture was clicked. That missed the first batch of tracks, which for a short playlist was all of
  them. Fixed 2026-09.)*
- `amazon-bridge.js` (isolated world) auto-scrolls the page until the list stops growing, so the page itself
  fetches every remaining batch. It scrolls the document if the document scrolls, and otherwise the tallest
  scrollable inner element, looking inside open shadow roots too.
- `engine/amazonExtract.js` walks the Skyfire template tree for row items. The field mapping was confirmed
  against real data: `primaryText` = title; `secondaryText1/2/3` = artist / album / duration; track id is
  the `trackAsin` query parameter of `primaryLink.deeplink` (not the row's own `id`).

**Operating notes / known limits**
- Navigate the Amazon tab to the playlist (or Library → Songs), **reload it**, wait for songs to appear,
  then click Capture. The reload guarantees that the first batch arrives while that page's URL is current.
  With in-app navigation, Amazon may fetch before it updates the URL.
- Verified live on a 37-track playlist (single response; extracted fields matched the screen exactly). A
  playlist large enough to need several continuation fetches has **not** been verified live yet. If a big
  import comes up short, look first at the scroll loop (`autoScrollAndCapture`) and the scroller detection
  (`amazon-bridge.js`).
- Capture works per page. Use the "This is my liked/library songs" checkbox to send a capture to Liked
  Music in Mirror mode.

---

## 1. What this is *not* like

YouTube Music (`SAPISIDHASH`, one auth header, cookie + a `ytcfg` config read) and JioSaavn (no client-side signing at all — cookies alone) were both approachable. Amazon's internal API — code-named **"Skyfire"** in its own interface strings (`TemplateListInterface`, `InteractionInterface.v1_0.InvokeHttpSkillMethod`, queue ids like `MT_HTTP`/`ST_HTTP`/`TEMPLATE`/`PLAYBACK`) — is a heavier, cross-surface (Alexa/mobile/web) command-and-template protocol with multiple layered, signed tokens. Treat it as a materially harder integration than the other two sources, not a variant of the same pattern.

## 2. Confirmed findings

### 2.1 Endpoint and transport
- Real request observed: `POST https://eu.web.skill.music.a2z.com/api/showLibraryPlaylist` (fired when opening a playlist's detail page on `music.amazon.in`).
- **The API lives on a completely different domain than `music.amazon.*`** — `*.skill.music.a2z.com`. The subdomain prefix appears to be **region-specific**: this India-based account's `appConfig.siteRegion` reads `"EU"`, and the host was `eu.web.skill.music.a2z.com`. A different subdomain, `zaz.mesk.skill.music.a2z.com`, was observed for interaction/playback calls (`elementClicked`, `playLibraryPlaylist`, `onInteraction`, `setPlaybackVolume`) — so there are at least two functional subdomains under the same `*.skill.music.a2z.com` suffix. **Manifest host_permissions for Amazon will need a wildcard like `https://*.skill.music.a2z.com/*`, not a fixed hostname**, and the actual host to call may need to be derived per-account rather than hardcoded.
- The request is `credentials: "omit"` — **no cookies are sent at all**. All auth is via the body (see below), not cookies, not real HTTP headers.
- Actual HTTP-level request headers are just ordinary browser ones: `accept: */*`, `accept-language`, `content-type: text/plain;charset=UTF-8`, `sec-ch-ua*`, `sec-fetch-*`, `priority`. **None of the `x-amzn-*` fields are sent as real HTTP headers.**

### 2.2 Where the auth/device values live (client-side)
Exactly analogous to YouTube Music's `ytcfg` — a page-global object only reachable from the page's own JS context (MAIN world in extension terms):

- **`window.amznMusic.appConfig`** — a plain object with (at least): `accessToken` (a bearer token, format `Atna|...`, long opaque string), `csrf` (`{ token, rnd, ts }`), `sessionId`, `deviceId`, `deviceType`, `customerId`, `marketplaceId`, `musicTerritory`, `version` (app version string), `displayLanguage`, `ageBand`, `isProfileCustomer`, `tier` (e.g. `"PRIME"`), `montanaCsrf` (observed empty string), `contentLanguagePreferences`, `siteRegion`.
- **`window.MusicJSBridge.store`** — a Redux store (`.getState()`, `.dispatch()`, `.subscribe()`). `state.Authentication.videoPlayerToken.header` holds a **ready-made JSON string**, already in the exact shape needed for the `x-amzn-video-player-token` field (see 2.3) — `{"interface":"VideoPlaybackInterface.v1_0.VideoPlaybackHeaderElement","token":"<JWT>","expirationMS":<epoch ms, ~24h out>}`.
  - **This field is only populated after the user has triggered playback at least once in the session.** On a fresh page load, before anything plays, `state.Authentication.videoPlayerToken` does not exist. It appeared after clicking a playlist's Play button. This is a real constraint: a clean read-only extraction flow may need to deliberately trigger (and then stop) playback once, early, purely to populate this token — or find a lighter-weight way to mint it.

### 2.3 Request body shape
The POST body (as `text/plain;charset=UTF-8`, itself a JSON string) is:
```json
{
  "id": "<target id, e.g. the playlist id>",
  "userHash": "{\"level\":\"PRIME_MEMBER\"}",
  "headers": "<JSON-stringified object — see below>"
}
```
`userHash` is itself a JSON *string* (double-encoded), observed value `{"level":"PRIME_MEMBER"}` for a Prime account regardless of `appConfig.tier` being `"PRIME"` (not `"PRIME_MEMBER"` — so this is a mapped/constant value, not a direct copy of `tier`).

`headers` is also a JSON *string* (double-encoded), and this is where **all** the real auth/device/session data goes. The exact key set observed in a genuine working request (26 keys, order as captured):

```
x-amzn-authentication      — {"interface":"ClientAuthenticationInterface.v1_0.ClientTokenElement","accessToken":"<appConfig.accessToken>"}
x-amzn-device-model        — "WEBPLAYER"
x-amzn-device-width        — window.innerWidth as a string
x-amzn-device-family       — "MobileWebPlayer"   (note: sent even though this was a desktop browser — hardcoded self-identification, not real device family)
x-amzn-device-id           — appConfig.deviceId
x-amzn-user-agent          — an Android/Chrome mobile UA string (also not the real browser's UA — appears hardcoded/spoofed by the client itself, matching the "MobileWebPlayer" self-identification)
x-amzn-session-id          — appConfig.sessionId
x-amzn-device-height       — window.innerHeight as a string
x-amzn-request-id          — a fresh UUID per request
x-amzn-device-language     — appConfig.displayLanguage (e.g. "en_IN")
x-amzn-currency-of-preference — "INR" (observed; presumably marketplace-derived)
x-amzn-os-version          — "1.0"
x-amzn-application-version — appConfig.version
x-amzn-device-time-zone    — IANA tz string, e.g. "Asia/Calcutta"
x-amzn-timestamp           — Date.now() in ms, current wall-clock time (confirmed NOT tied to the csrf token's own timestamp — they were ~6 minutes apart in the real capture)
x-amzn-csrf                — {"interface":"CSRFInterface.v1_0.CSRFHeaderElement","token":"<appConfig.csrf.token>","timestamp":"<appConfig.csrf.ts>","rndNonce":"<appConfig.csrf.rnd>"}
x-amzn-music-domain        — the page's hostname, e.g. "music.amazon.in"
x-amzn-referer             — same hostname
x-amzn-affiliate-tags      — "" (empty in this capture)
x-amzn-ref-marker          — "" (empty)
x-amzn-page-url            — full page URL
x-amzn-weblab-id-overrides — "" (empty)
x-amzn-video-player-token  — state.Authentication.videoPlayerToken.header verbatim (see 2.2)
x-amzn-feature-flags       — "" (empty)
x-amzn-has-profile-id      — "true"/"false" from appConfig.isProfileCustomer
x-amzn-age-band            — appConfig.ageBand (e.g. "ADULT")
```

Note: an earlier `Access-Control-Allow-Headers` response header (seen when these were mistakenly sent as *real* HTTP headers, before we realized they belong in the body) listed a larger set including `x-amzn-device-type-id`, `x-amzn-hardware-device-type-id`, `x-amzn-device-scale`, `x-amzn-device-request-id`, `x-amzn-is-24-hour-format`, `x-amzn-video-player-envelope`, `x-amzn-performance-request-id`. **None of these appeared in the actual working request's body**, so they're likely either optional or specific to other endpoints — don't assume they're required.

## 3. The open blocker

A from-scratch reconstruction — reading every field above live from `appConfig`/the Redux store at request time, including a freshly-triggered `videoPlayerToken`, matching `credentials: "omit"`, and matching the exact 26-key set observed — consistently reaches the server (**HTTP 200, valid JSON, CORS succeeds**) but gets back a generic Skyfire dialog template:
```json
{"methods":[{"interface":"TemplateListInterface.v1_0.CreateAndBindTemplateMethod","template":{"interface":"Web.TemplatesInterface.v1_0.Touch.DialogTemplateInterface.DialogTemplate","header":"Service error", ... "text":"Sorry something went wrong. Please try one more time or contact customer service if the problem persists." ...}}]}
```
No error code, no request-id echo, nothing else diagnostic in the body. This exact same response (byte-identical length, 1186 bytes) came back across every variation tried, which gave us no differential signal to narrow down the cause.

A **literal replay** of a real, DevTools-"Copy as fetch"-captured working request (using its original, several-minutes-old captured token values) failed even harder — a network-level `Failed to fetch` (a CORS-stage rejection, not even reaching the point of getting a response) — consistent with those specific captured tokens/csrf values being single-use or short-lived and already consumed. This is useful signal (there's real replay protection somewhere), but doesn't explain why *fresh* live-read values also failed.

### Hypotheses tried and their status
- ~~Missing HTTP-level headers causing CORS rejection~~ — fixed (`x-amzn-has-profile-id` isn't in the CORS allow-list as a real header; dropping it from real headers, keeping it only in body.headers, got past CORS to a 200).
- ~~`credentials: "include"` vs `"omit"`~~ — matched to `"omit"`, no change in outcome.
- ~~Missing `x-amzn-video-player-token`~~ — added (sourced live from the Redux store after triggering playback), no change in outcome.
- ~~Stale `appConfig.csrf`/`accessToken` (read once at page load, never rotates)~~ — confirmed `appConfig.csrf.ts` does NOT change over a several-second window on its own; tried a full page reload immediately before firing to get the freshest possible read — no change in outcome.
- **Not yet tried:** generating a *fresh* random nonce for `x-amzn-csrf`'s `rndNonce` field instead of reusing `appConfig.csrf.rnd` verbatim. We only ever reused the cached value. If the CSRF scheme expects a client-generated nonce paired with a server-issued `token`/`timestamp`, reusing a stale cached nonce (rather than generating a new one per request) could be exactly the mismatch. **This is the most promising untried lead.**
- **Not yet tried:** checking the DevTools **Console** tab for a client-side-logged validation error at the moment of a genuine request (the app may surface a specific error the response body doesn't).
- **Not yet tried:** whether the "Songs" library tab (a different endpoint, likely `showLibrarySongs` or similar — not yet captured) has simpler requirements, or hits the identical wall (would tell us if this is a `showLibraryPlaylist`-specific issue or systemic to all Skyfire calls).
- **Considered, judged unlikely but not disprovable from JS:** server-side validation tied to something outside JS-observable state (IP/TLS fingerprint consistency, etc.). Same browser, same session, same-origin-adjacent fetch — low probability, but can't be ruled out from here.

### A tooling caveat for whoever continues this
This investigation was done through an AI browser-automation tool (Claude driving the operator's real Chrome) that applies its own safety redaction over any script output containing patterns that look like credentials (session ids, tokens, csrf values, even a `.length` of one). This did **not** block the actual JS execution — the real values were genuinely used in every `fetch()` call, confirmed by reaching a real 200 response — but it did prevent doing a direct byte-level diff of the actual token/csrf values between a working and non-working attempt. If you have direct DevTools access yourself (not through an automation layer with this kind of output filtering), a manual side-by-side diff of two consecutive real requests' `headers` body field (one from the page itself, one from a manual `fetch()` in the console) would likely spot the discrepancy much faster than we could from outside.

## 4. Suggested next steps, in order of promise
1. Try generating a **fresh random `rndNonce`** for `x-amzn-csrf` (instead of reusing `appConfig.csrf.rnd`) while keeping `token`/`timestamp` as-read. If nonces are meant to be per-request and the token is validated against a nonce+timestamp+session combination server-side, a stale reused nonce is a clean explanation for a request that's otherwise well-formed.
2. Open DevTools Console while the page fires a real `showLibraryPlaylist` call and see if anything is logged client-side about request construction or a validation failure — the app itself may have visibility we don't.
3. Capture the equivalent call for the plain "Songs" library view (Library → Songs, not a specific playlist) to see if it's a simpler endpoint or hits the same wall.
4. If still stuck, it may be worth checking whether `appConfig` exposes a live CSRF-refresh mechanism (a function, not just a static read) — we did not find one, but didn't exhaustively search the webpack bundle (`window.amznMusic.dynamicConfig` / lazy-loaded chunks were not inspected in depth).

## 5. Reference material already in this repo
- `migrator/EXTENSION_SPEC.md` — the full implementation contract (Phase 3 is §15 of this).
- `PROGRESS_REPORT.md` — the original Python-CLI-era findings, including JioSaavn's endpoint discovery (§2.1) and the YT Music auth setup saga (§3) — useful background on how much simpler those two sources turned out to be by comparison.
- Phases 0–2 of the extension (`migrator/extension/`) are built, merged, and verified live against the real account — this Amazon work is the only unfinished piece of the originally-scoped phases.
