"""Shared Playwright helpers for extractors: persistent login, JSON capture,
autoscroll, count-verify. See BUILD_SPEC §6 for the tiered extraction strategy
this supports (network JSON capture > direct paginated calls > DOM scrape).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

logger = logging.getLogger(__name__)


class CountMismatchError(Exception):
    """Raised when captured-unique count doesn't match the stated total.
    Fail loudly rather than silently returning a partial list (§6)."""


class SessionExpiredError(Exception):
    """Raised when a source's login session appears to have expired mid-run."""


def launch_persistent_context(profile_dir: str | Path, headless: bool = False) -> tuple[BrowserContext, "PlaywrightHandle"]:
    """Launch a Chromium context backed by a persistent profile dir, so a
    manual login on first run is reused on later runs."""
    profile_dir = Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        user_data_dir=str(profile_dir),
        headless=headless,
    )
    return context, pw


def wait_for_manual_login(page: Page, check_fn, prompt: str, poll_seconds: float = 2.0, timeout_seconds: float = 600.0) -> None:
    """Poll `check_fn(page) -> bool` until it returns True (operator has
    logged in) or timeout. `check_fn` should look for a logged-in-only
    element/URL, not just page load."""
    import time

    print(prompt)
    elapsed = 0.0
    while elapsed < timeout_seconds:
        try:
            if check_fn(page):
                return
        except Exception:  # noqa: BLE001 - page may still be navigating
            pass
        time.sleep(poll_seconds)
        elapsed += poll_seconds
    raise SessionExpiredError(f"Timed out waiting for manual login after {timeout_seconds}s")


class JsonCapture:
    """Attach to page.on('response', ...) and collect JSON bodies whose URL
    contains `url_substring`. Immune to DOM recycling since data is taken
    off the wire. Scrolling is used only to trigger the app to fetch more."""

    def __init__(self, page: Page, url_substring: str):
        self.page = page
        self.url_substring = url_substring
        self.payloads: list[dict] = []
        self._handler = None

    def __enter__(self) -> "JsonCapture":
        def handler(response):
            if self.url_substring in response.url:
                try:
                    if "application/json" in (response.headers.get("content-type") or ""):
                        self.payloads.append(response.json())
                except Exception as e:  # noqa: BLE001
                    logger.debug("JsonCapture: failed to parse response from %s: %s", response.url, e)

        self._handler = handler
        self.page.on("response", handler)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._handler is not None:
            self.page.remove_listener("response", self._handler)


def autoscroll_until_stable(
    page: Page,
    container_selector: str,
    max_idle_rounds: int = 3,
    max_scroll_attempts: int = 500,
    on_round=None,
) -> int:
    """Scroll `container_selector` one viewport at a time, waiting for render,
    until `max_idle_rounds` consecutive scrolls produce no new content growth
    (as judged by `on_round()` returning a growing count, e.g. len(captured_set)).
    Returns the number of scroll rounds performed. Capped so a stuck/absent
    total can't loop forever.
    """
    idle_rounds = 0
    last_count = -1
    rounds = 0

    while rounds < max_scroll_attempts and idle_rounds < max_idle_rounds:
        page.eval_on_selector(
            container_selector,
            "(el) => el.scrollTo(0, el.scrollHeight)",
        )
        page.wait_for_timeout(400)
        rounds += 1

        current_count = on_round() if on_round else None
        if current_count is not None:
            if current_count <= last_count:
                idle_rounds += 1
            else:
                idle_rounds = 0
            last_count = current_count

    return rounds


def verify_count(captured: int, stated: int) -> None:
    """Fail loudly on a mismatch rather than silently returning a partial list."""
    if captured != stated:
        gap = stated - captured
        raise CountMismatchError(
            f"expected {stated}, captured {captured} — {abs(gap)} {'missing' if gap > 0 else 'extra'}"
        )


def dump_raw_payloads(payloads: list, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payloads, f, ensure_ascii=False, indent=2)
