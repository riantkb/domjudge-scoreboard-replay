#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Serve the viewer and its public replay JSON files locally."""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

SITE_DIR = Path(__file__).resolve().parent.parent / "docs"
MANIFEST_FILE = SITE_DIR / "data" / "contests.manifest.json"
STATIC_PATHS = {
    "/",
    "/index.html",
    "/styles.css",
    "/domjudge-match.css",
    "/LICENSES/GPL-2.0.txt",
    "/replay.js",
}


def public_paths() -> set[str]:
    if not MANIFEST_FILE.is_file():
        raise SystemExit("Replay data not found. Run: python3 tools/build_replay_data.py --contest /path/to/export-directory")
    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    contests = manifest.get("contests")
    if not isinstance(contests, list) or not contests:
        raise SystemExit(f"Invalid {MANIFEST_FILE.name}: no contests")
    paths = STATIC_PATHS | {f"/data/{MANIFEST_FILE.name}"}
    for contest in contests:
        contest_id = contest.get("id")
        filename = contest.get("file")
        if (not isinstance(contest_id, str) or not contest_id
                or contest_id != contest_id.casefold()
                or not all(part.isalnum() for part in contest_id.split("-"))
                or filename != f"{contest_id}.json"):
            raise SystemExit(f"Invalid {MANIFEST_FILE.name}: unsafe contest filename")
        if not (SITE_DIR / "data" / filename).is_file():
            raise SystemExit(f"Replay data not found: {filename}")
        paths.add(f"/data/{filename}")
    return paths


class ViewerRequestHandler(SimpleHTTPRequestHandler):
    """Serve only the site's public files."""

    allowed_paths = STATIC_PATHS

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)

    def end_headers(self) -> None:
        # Local development changes should never mix old JS with new HTML.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        if unquote(urlsplit(self.path).path) not in self.allowed_paths:
            self.send_error(404, "File not published")
            return None
        return super().send_head()

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1", help="bind address")
    parser.add_argument("--port", type=int, default=8000, help="listen port")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ViewerRequestHandler.allowed_paths = public_paths()

    url_host = "localhost" if args.bind in {"127.0.0.1", "::1"} else args.bind
    server = ThreadingHTTPServer((args.bind, args.port), ViewerRequestHandler)
    print(f"Scoreboard viewer: http://{url_host}:{args.port}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
