#!/usr/bin/env python3
"""Provision IAI bridge bearer tokens (server-side only).

Usage:
    python3 provision-token.py --file /srv/buster/iai-memory/.bridge-token
    python3 provision-token.py --file /srv/buster/iai-memory/.bridge-token --rotate

The token file is created with mode 0600. The token itself is NEVER printed;
only the file path and rotation metadata go to stdout. Run as the service
user (adzs). Requires no third-party dependencies (stdlib only).
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import secrets
import stat
import sys

TOKEN_BYTES = 48


def _utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _load(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {"active": "", "previous": None, "rotatedAt": None}
    if not isinstance(data, dict) or not isinstance(data.get("active"), str):
        raise SystemExit(f"refusing to use corrupt token file: {path}")
    return {
        "active": data["active"],
        "previous": data["previous"] if isinstance(data.get("previous"), str) else None,
        "rotatedAt": data["rotatedAt"] if isinstance(data.get("rotatedAt"), str) else None,
    }


def _write_restricted(path: str, payload: dict) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode != 0o600:
        raise SystemExit(f"token file permissions are {oct(mode)}, expected 0o600: {path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Provision IAI bridge bearer tokens.")
    parser.add_argument("--file", required=True, help="Restricted token file path (0600).")
    parser.add_argument("--rotate", action="store_true", help="Rotate: keep current as previous.")
    args = parser.parse_args(argv)

    current = _load(args.file)
    fresh = secrets.token_urlsafe(TOKEN_BYTES)
    if args.rotate and current["active"]:
        payload = {"active": fresh, "previous": current["active"], "rotatedAt": _utcnow()}
    else:
        payload = {"active": fresh, "previous": None, "rotatedAt": None}
    _write_restricted(args.file, payload)
    print(f"wrote token file: {args.file} (rotate={args.rotate})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
