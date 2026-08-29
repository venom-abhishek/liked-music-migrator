"""CLI dispatcher for the migrator. See BUILD_SPEC §12 for the full workflow."""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import yaml

# Windows consoles default to a legacy codepage (cp1252) that raises on
# titles with emoji/regional scripts. Reconfigure to UTF-8 so unicode
# titles (Hindi, accented, emoji, etc.) never crash a print().
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

from engine import ytm_auth
from engine import importer as importer_mod
from engine import ledger as ledger_mod

DATA_DIR = Path("data")
CONFIG_PATH = Path("config.yaml")


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def cmd_setup_ytm(args) -> None:
    if args.from_curl_file:
        ytm_auth.setup_ytm_from_curl_file(
            args.from_curl_file, DATA_DIR / "browser.json", cookie_file_path=args.cookie_file
        )
    elif args.from_curl:
        ytm_auth.setup_ytm_from_curl(DATA_DIR / "browser.json")
    elif args.from_fetch:
        ytm_auth.setup_ytm_from_fetch(DATA_DIR / "browser.json")
    else:
        ytm_auth.setup_ytm(DATA_DIR / "browser.json")


def cmd_inventory(args) -> None:
    if args.source == "jiosaavn":
        from extractors import jiosaavn

        data = jiosaavn.inventory()
        liked = data.get("liked", {})
        print(f"\nLiked / Favorite songs: {liked.get('count', '?')}")
        print("\nPlaylists:")
        for p in data.get("playlists", []):
            print(f"  - {p['name']} ({p['count']} tracks)")
    else:
        print(f"Unknown or unimplemented source: {args.source}")
        sys.exit(1)


def cmd_extract(args) -> None:
    if args.source == "jiosaavn":
        from extractors import jiosaavn

        out_path = jiosaavn.extract(selection=None)
        print(f"Wrote {out_path}")
    else:
        print(f"Unknown or unimplemented source: {args.source}")
        sys.exit(1)


def cmd_import(args) -> None:
    config = load_config()
    yt = ytm_auth.get_client(DATA_DIR / "browser.json")

    if args.approved:
        importer_mod.run_approved(
            review_csv_path=args.approved,
            yt=yt,
            config=config,
            commit=args.commit,
            data_dir=str(DATA_DIR),
        )
        return

    if not args.csv_path:
        print("import requires a csv_path, or --approved <review.csv>")
        sys.exit(1)
    if not args.mode:
        print("import requires --mode A|B|C")
        sys.exit(1)
    if args.mode == "B" and not args.playlist_name:
        print("--playlist-name is required for Mode B")
        sys.exit(1)

    importer_mod.run_import(
        csv_path=args.csv_path,
        mode=args.mode,
        yt=yt,
        config=config,
        playlist_name=args.playlist_name or "",
        commit=args.commit,
        data_dir=str(DATA_DIR),
    )


def cmd_undo(args) -> None:
    config = load_config()
    yt = ytm_auth.get_client(DATA_DIR / "browser.json")
    ledger = ledger_mod.Ledger(DATA_DIR / "ledger.csv")
    delay = (
        config.get("importer", {}).get("delay_min_sec", 1.0),
        config.get("importer", {}).get("delay_max_sec", 2.5),
    )
    result = ledger_mod.undo(args.run_id, yt, ledger, delay_range=delay)
    print("\nUndo complete:")
    print(f"  unliked:               {result['unliked']}")
    print(f"  removed playlist items: {result['removed_playlist_items']}")
    print(f"  deleted playlists:      {result['deleted_playlists']}")
    if result["errors"]:
        print(f"  errors: {len(result['errors'])}")
        for e in result["errors"]:
            print(f"    - {e}")


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[
            logging.FileHandler(DATA_DIR / "migrator.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )

    parser = argparse.ArgumentParser(prog="run.py", description="Music library migrator -> YouTube Music")
    sub = parser.add_subparsers(dest="command", required=True)

    p_setup = sub.add_parser("setup-ytm", help="Interactive YT Music auth setup")
    p_setup.add_argument(
        "--from-curl-file",
        metavar="PATH",
        help="Read a 'Copy as cURL' command from a file instead of pasting into the terminal (recommended on Windows — avoids cmd.exe's paste/line-length limits on the long Cookie header)",
    )
    p_setup.add_argument(
        "--cookie-file",
        metavar="PATH",
        help="File containing just the raw Cookie header value, to merge into --from-curl-file's headers (needed because current Chrome omits Cookie from both 'Copy as fetch' and 'Copy as cURL')",
    )
    p_setup.add_argument(
        "--from-curl",
        action="store_true",
        help="Paste DevTools 'Copy as cURL (bash)' output directly into the terminal instead of raw headers",
    )
    p_setup.add_argument(
        "--from-fetch",
        action="store_true",
        help="Paste DevTools 'Copy as fetch' output (NOTE: Chrome omits Cookie from this format, so it usually won't work for YT Music auth)",
    )
    p_setup.set_defaults(func=cmd_setup_ytm)

    p_inv = sub.add_parser("inventory", help="Print library shape for a source")
    p_inv.add_argument("source", choices=["jiosaavn", "amazon"])
    p_inv.set_defaults(func=cmd_inventory)

    p_ext = sub.add_parser("extract", help="Extract selected collections to CSV")
    p_ext.add_argument("source", choices=["jiosaavn", "amazon"])
    p_ext.set_defaults(func=cmd_extract)

    p_imp = sub.add_parser("import", help="Match + write a normalized CSV into YT Music")
    p_imp.add_argument("csv_path", nargs="?", help="Path to normalized source CSV")
    p_imp.add_argument("--mode", choices=["A", "B", "C"], help="Destination mode")
    p_imp.add_argument("--playlist-name", help="Target playlist name (required for Mode B)")
    p_imp.add_argument("--approved", help="Path to an edited review.csv to commit (uses stored candidate videoId, no re-search)")
    p_imp.add_argument("--commit", action="store_true", help="Apply writes. Without this, dry-run only.")
    p_imp.set_defaults(func=cmd_import)

    p_undo = sub.add_parser("undo", help="Reverse a prior run by run_id")
    p_undo.add_argument("run_id")
    p_undo.set_defaults(func=cmd_undo)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
