#!/usr/bin/env python3
"""Durable idempotency journal for the IAI bridge (stdlib only).

Replaces the original process-local acknowledgement table so request
identity survives bridge restarts:

- ``begin()`` records a key bound to (content hash, bank, project). A
  repeat with identical binding replays the stored acknowledgement without
  rewriting the engine. A repeat with a DIFFERENT binding is rejected:
  idempotency keys must never be reused for different content or scope.
- ``complete()`` marks the key acknowledged after durable persistence.
- A key left ``pending`` by a crash resumes on retry: the caller re-runs
  capture (the engine deduplicates exact content) and then completes.

The journal holds only keys, hashes, and record ids — never bearer tokens
or private keys — so including it in data backups is safe. The file is
created with mode 0600.
"""

from __future__ import annotations

import datetime
import os
import sqlite3
import threading


class KeyReuseError(ValueError):
    """An idempotency key was reused with different content or scope."""


_SCHEMA = """
CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    record_key TEXT NOT NULL,
    bank TEXT NOT NULL,
    project TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    record_id TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT
)
"""


def _utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class IdempotencyJournal:
    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        fresh = not os.path.exists(path)
        # The bridge serves each connection on its own thread sharing one
        # journal handle, so cross-thread use is explicit and serialized.
        self._conn = sqlite3.connect(path, timeout=10.0, check_same_thread=False)
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        except Exception:
            self._conn.close()
            raise
        if fresh:
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    def begin(
        self,
        *,
        key: str,
        record_key: str,
        bank: str,
        project: str,
        content_hash: str,
        size_bytes: int,
    ) -> dict:
        """Register an archive attempt. Returns replay state for retries."""
        with self._lock:
            row = self._conn.execute(
                "SELECT record_key, bank, project, content_hash, bytes, record_id, state"
                " FROM idempotency WHERE key = ?",
                (key,),
            ).fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO idempotency"
                    " (key, record_key, bank, project, content_hash, bytes, record_id, state, created_at, acked_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)",
                    (key, record_key, bank, project, content_hash, size_bytes, _utcnow()),
                )
                self._conn.commit()
                return {"status": "new"}
            existing_key, existing_bank, existing_project, existing_hash, existing_bytes = row[:5]
            record_id, state = row[5], row[6]
            if (
                existing_key != record_key
                or existing_bank != bank
                or existing_project != project
                or existing_hash != content_hash
                or existing_bytes != size_bytes
            ):
                raise KeyReuseError(f"idempotency key reused with different content or scope: {key}")
            if state == "acked":
                return {"status": "replay-acked", "record_id": record_id}
            return {"status": "replay-pending", "record_id": record_id}

    def complete(self, key: str, record_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE idempotency SET state = 'acked', record_id = ?, acked_at = ? WHERE key = ?",
                (record_id, _utcnow(), key),
            )
            self._conn.commit()

    def pending_count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) FROM idempotency WHERE state = 'pending'").fetchone()
        return int(row[0]) if row else 0
