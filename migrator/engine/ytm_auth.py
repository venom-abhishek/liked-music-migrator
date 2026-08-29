"""YT Music auth: browser-header setup + active-account verification."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from ytmusicapi import YTMusic, setup

BROWSER_JSON = Path("data/browser.json")


def setup_ytm(browser_json_path: str | Path = BROWSER_JSON) -> None:
    """Interactive one-time setup: operator pastes raw request headers copied
    from music.youtube.com DevTools (Network tab, any authenticated POST
    request). Writes data/browser.json.
    """
    browser_json_path = Path(browser_json_path)
    browser_json_path.parent.mkdir(parents=True, exist_ok=True)
    print("Paste the request headers from music.youtube.com (DevTools > Network).")
    print("End input with an empty line.\n")
    setup(filepath=str(browser_json_path))
    print(f"\nSaved auth to {browser_json_path}")
    verify_account(get_client(browser_json_path))


def setup_ytm_from_fetch(browser_json_path: str | Path = BROWSER_JSON) -> None:
    """Alternate setup path: operator pastes the DevTools "Copy as fetch"
    snippet instead of raw headers.

    NOTE: Chrome's "Copy as fetch" deliberately omits the Cookie header
    (JS fetch() isn't allowed to set it), so this path cannot work for
    YT Music auth on its own — kept only in case a future Chrome version
    changes that, or for capturing the non-cookie headers as a base.
    Prefer setup_ytm_from_curl().
    """
    browser_json_path = Path(browser_json_path)
    browser_json_path.parent.mkdir(parents=True, exist_ok=True)
    print("In DevTools > Network, right-click the request > Copy > 'Copy as fetch'.")
    print("Paste the whole fetch(...) snippet below. End input with an empty line.\n")

    fetch_text = _read_multiline_stdin()
    headers = _parse_fetch_headers(fetch_text)
    if not headers:
        raise ValueError(
            "Could not find a headers object in the pasted text. Make sure you "
            "used 'Copy as fetch' (not 'Copy as fetch (Node.js)' or cURL)."
        )
    _finish_setup_from_headers(headers, browser_json_path)


def setup_ytm_from_curl(browser_json_path: str | Path = BROWSER_JSON) -> None:
    """Setup path: operator pastes the DevTools "Copy as cURL (bash)" command.

    Unlike "Copy as fetch", curl isn't bound by the browser's fetch() header
    restrictions, so this is the one that actually includes the Cookie header
    we need. Also avoids the line-wrap corruption of hand-copying the
    pretty-printed Headers panel.
    """
    browser_json_path = Path(browser_json_path)
    browser_json_path.parent.mkdir(parents=True, exist_ok=True)
    print("In DevTools > Network, right-click the request > Copy > 'Copy as cURL (bash)'.")
    print("Paste the whole curl command below. End input with an empty line.\n")

    curl_text = _read_multiline_stdin()
    headers = _parse_curl_headers(curl_text)
    if not headers:
        raise ValueError(
            "Could not find any -H header flags in the pasted text. Make sure you "
            "used 'Copy as cURL (bash)'."
        )
    _finish_setup_from_headers(headers, browser_json_path)


def setup_ytm_from_curl_file(
    curl_file_path: str,
    browser_json_path: str | Path = BROWSER_JSON,
    cookie_file_path: str | None = None,
) -> None:
    """Same as setup_ytm_from_curl, but reads the cURL command from a file
    instead of stdin — avoids Windows Command Prompt's paste/line-length
    limits on the long Cookie header line.

    Recent Chrome versions omit the Cookie header from BOTH "Copy as fetch"
    and "Copy as cURL" (a privacy hardening change), so if it's missing from
    the cURL capture, pass `cookie_file_path` pointing at a file containing
    just the raw cookie value (copied directly from the Headers panel's
    Cookie row) and it'll be merged in.
    """
    browser_json_path = Path(browser_json_path)
    browser_json_path.parent.mkdir(parents=True, exist_ok=True)
    curl_text = Path(curl_file_path).read_text(encoding="utf-8")
    headers = _parse_curl_headers(curl_text)
    print(f"Parsed {len(headers)} headers from {curl_file_path}: {sorted(headers.keys())}")
    if not headers:
        raise ValueError(
            "Could not find any -H header flags in that file. Make sure you pasted "
            "the full 'Copy as cURL (bash)' output and saved it."
        )

    if cookie_file_path:
        cookie_value = Path(cookie_file_path).read_text(encoding="utf-8").strip()
        if not cookie_value:
            raise ValueError(f"{cookie_file_path} is empty.")
        headers["cookie"] = cookie_value
        print(f"Merged in cookie value from {cookie_file_path} ({len(cookie_value)} chars).")

    if "cookie" not in (k.lower() for k in headers):
        raise ValueError(
            "No 'cookie' header found. Recent Chrome versions omit Cookie from "
            "'Copy as cURL' entirely (same as 'Copy as fetch') — re-run with "
            "--cookie-file pointing at a file containing just the raw cookie value, "
            "copied directly from the Headers panel's Cookie row."
        )
    _finish_setup_from_headers(headers, browser_json_path)


def _read_multiline_stdin() -> str:
    lines = []
    while True:
        line = sys.stdin.readline()
        if not line or line.strip() == "":
            break
        lines.append(line)
    return "".join(lines)


def _finish_setup_from_headers(headers: dict[str, str], browser_json_path: Path) -> None:
    if not any(k.lower() == "x-goog-authuser" for k in headers):
        headers["X-Goog-AuthUser"] = "0"
        print("Note: 'x-goog-authuser' wasn't in the captured headers — defaulted to '0'.")
        print("If ytmusicapi ends up reading the wrong Google account, re-run this")
        print("and change the 0 by editing data/browser.json's 'x-goog-authuser' value.\n")

    raw_text = "\n".join(f"{k}: {v}" for k, v in headers.items())
    setup(filepath=str(browser_json_path), headers_raw=raw_text)
    print(f"\nSaved auth to {browser_json_path}")
    verify_account(get_client(browser_json_path))


def _parse_fetch_headers(fetch_text: str) -> dict[str, str]:
    """Extract the headers dict out of a DevTools 'Copy as fetch' snippet.

    That snippet's headers block is valid JSON (double-quoted keys/values),
    so once we isolate the `"headers": { ... }` object by brace-counting
    (respecting quoted strings), json.loads handles the rest — including
    any literal braces inside cookie values.
    """
    match = re.search(r'"headers"\s*:\s*\{', fetch_text)
    if not match:
        return {}
    start = match.end() - 1  # index of the opening '{'
    depth = 0
    in_string = False
    escape = False
    end = None
    for i in range(start, len(fetch_text)):
        ch = fetch_text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    if end is None:
        return {}
    return json.loads(fetch_text[start:end])


def _parse_curl_headers(curl_text: str) -> dict[str, str]:
    """Extract -H 'Name: Value' (or -H "Name: Value") flags from a
    'Copy as cURL' command — works with both the bash variant (single
    quotes, embedded quote written as '\\'') and the cmd/PowerShell variant
    (double quotes, embedded quote written as "").
    """
    headers: dict[str, str] = {}
    i = 0
    n = len(curl_text)
    flag_re = re.compile(r"""-H\s+(['"])""")
    while True:
        m = flag_re.search(curl_text, i)
        if not m:
            break
        quote = m.group(1)
        escaped_quote = "'\\''" if quote == "'" else quote * 2
        j = m.end()
        value_chars = []
        while j < n:
            if curl_text[j] == quote:
                if curl_text[j : j + len(escaped_quote)] == escaped_quote:
                    value_chars.append(quote)
                    j += len(escaped_quote)
                    continue
                j += 1
                break
            value_chars.append(curl_text[j])
            j += 1
        raw = "".join(value_chars)
        if ":" in raw:
            key, _, value = raw.partition(":")
            headers[key.strip()] = value.strip()
        i = j
    return headers


def get_client(browser_json_path: str | Path = BROWSER_JSON) -> YTMusic:
    browser_json_path = Path(browser_json_path)
    if not browser_json_path.exists():
        raise FileNotFoundError(
            f"{browser_json_path} not found. Run `python run.py setup-ytm` first."
        )
    return YTMusic(str(browser_json_path))


def verify_account(yt: YTMusic) -> dict:
    """Print the active account so the operator can confirm it's correct.

    ytmusicapi can silently read the wrong Google account when several are
    signed in. If this looks wrong, add "X-Goog-AuthUser" to the pasted
    headers and re-run setup-ytm.
    """
    try:
        liked = yt.get_liked_songs(limit=1)
        track_count = len(liked.get("tracks", []))
        print("=" * 60)
        print("YT Music account check")
        print(f"  Liked songs reachable: yes ({track_count} sample track fetched)")
        print(
            "  If this is the wrong Google account, re-run setup-ytm and add "
            "'X-Goog-AuthUser' to the pasted headers."
        )
        print("=" * 60)
        return {"ok": True, "sample_liked_count": track_count}
    except Exception as e:  # noqa: BLE001 - surface any auth failure to operator
        print("=" * 60)
        print("YT Music account check FAILED")
        print(f"  Error: {e}")
        print(
            "  This may mean auth headers are stale/expired, or you're on a "
            "brand account (rate_song can fail there). Re-run setup-ytm."
        )
        print("=" * 60)
        return {"ok": False, "error": str(e)}
