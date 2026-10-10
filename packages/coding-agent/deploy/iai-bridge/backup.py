#!/usr/bin/env python3
"""Snapshot IAI memory databases to the backup volume (stdlib only).

Usage:
    python3 backup.py --store /srv/buster/iai-memory --dest /srv/storage/iai-backups

Copies each *.db via the SQLite backup API (safe under concurrent readers),
then writes a SHA-256 manifest. Never deletes source files. Run as adzs.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import os
import sqlite3
import sys
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _backup_db(source: Path, dest: Path) -> None:
    source_conn = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(dest)
        try:
            source_conn.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        source_conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Snapshot IAI memory databases.")
    parser.add_argument("--store", required=True)
    parser.add_argument("--dest", required=True)
    args = parser.parse_args(argv)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.dest) / f"iai-backup-{stamp}"
    out_dir.mkdir(parents=True, exist_ok=False)

    manifest: list[str] = []
    for db in sorted(Path(args.store).glob("*.db")):
        target = out_dir / db.name
        _backup_db(db, target)
        manifest.append(f"{_sha256(target)}  {db.name}")

    (out_dir / "SHA256SUMS").write_text("\n".join(manifest) + "\n", encoding="utf-8")
    print(f"backup complete: {out_dir} ({len(manifest)} databases)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
