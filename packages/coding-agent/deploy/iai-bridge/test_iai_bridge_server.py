#!/usr/bin/env python3
"""Unit tests for iai_bridge_server.py (fake engine only, stdlib unittest).

Run:  python3 test_iai_bridge_server.py
Covers: auth-before-dispatch, scoping, size/limit validation, durable ack
semantics, idempotent retries, malformed frames, engine-failure envelopes.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iai_bridge_server import (  # noqa: E402
    BridgeServer,
    EngineError,
    MemoryEngine,
    load_token_set,
    parse_envelope,
    require_durable_archive,
)


def _write_tokens(path: str, active: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"active": active, "previous": None, "rotatedAt": None}, handle)
    os.chmod(path, 0o600)


def _archive_body(**overrides):
    content = overrides.pop("content", "hello bridge")
    body = {
        "key": "mem-1",
        "bank": "project-x",
        "projectId": "x",
        "sessionId": "s",
        "contentHash": hashlib.sha256(content.encode()).hexdigest(),
        "bytes": len(content),
        "idempotencyKey": "idem-1",
        "version": 0,
        "content": content,
    }
    body.update(overrides)
    return body


def _frame(server, kind, body, auth="sekret"):
    return server.handle_frame(json.dumps({"v": 1, "id": "r1", "kind": kind, "auth": auth, "body": body}))


class BridgeServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token_file = os.path.join(self.tmp.name, ".bridge-token")
        _write_tokens(self.token_file, "sekret")
        self.server = BridgeServer(token_file=self.token_file, engine=MemoryEngine())

    def test_auth_before_dispatch(self) -> None:
        reply = _frame(self.server, "archive", _archive_body(), auth="wrong")
        self.assertEqual(reply["kind"], "error")
        self.assertEqual(reply["body"]["code"], "unauthorized")
        self.assertEqual(self.server.engine.records, {})

    def test_archive_ack_only_after_persistence(self) -> None:
        reply = _frame(self.server, "archive", _archive_body())
        self.assertEqual(reply["kind"], "archive-ack")
        self.assertTrue(reply["body"]["durable"])
        self.assertIn("mem-1", self.server.engine.records)

    def test_idempotent_retry(self) -> None:
        first = _frame(self.server, "archive", _archive_body())
        second = _frame(self.server, "archive", _archive_body())
        self.assertEqual(first["body"]["idempotencyKey"], second["body"]["idempotencyKey"])
        self.assertTrue(second["body"].get("duplicate"))
        self.assertEqual(len(self.server.engine.records), 1)

    def test_hash_mismatch_rejected(self) -> None:
        body = _archive_body(contentHash="0" * 64)
        reply = _frame(self.server, "archive", body)
        self.assertEqual(reply["kind"], "error")
        self.assertEqual(reply["body"]["code"], "hash-mismatch")

    def test_recall_scoped_and_bounded(self) -> None:
        _frame(self.server, "archive", _archive_body(key="a", content="alpha project-x"))
        _frame(
            self.server,
            "archive",
            _archive_body(key="b", idempotencyKey="idem-2", content="beta other"),
        )
        reply = _frame(
            self.server, "recall", {"query": "alpha", "bank": "project-x", "projectId": "x", "limit": 10}
        )
        self.assertEqual(reply["kind"], "recall-result")
        keys = [item["key"] for item in reply["body"]["items"]]
        self.assertIn("a", keys)
        self.assertNotIn("b", keys)

        bad = _frame(self.server, "recall", {"query": "x", "bank": "b", "projectId": "p", "limit": 500})
        self.assertEqual(bad["kind"], "error")

    def test_malformed_frames_never_crash(self) -> None:
        for frame in ("not-json", '{"v": 999}', '{"v": 1}'):
            envelope, error = parse_envelope(frame)
            self.assertIsNone(envelope)
            self.assertIsNotNone(error)
        reply = self.server.handle_frame("not-json")
        self.assertEqual(reply["kind"], "error")

    def test_engine_failure_envelope(self) -> None:
        self.server.engine.fail_next = "boom"
        reply = _frame(self.server, "archive", _archive_body())
        self.assertEqual(reply["kind"], "error")
        self.assertEqual(reply["body"]["code"], "engine-unavailable")

    def test_skipped_capture_is_never_acknowledged(self) -> None:
        with self.assertRaises(EngineError):
            require_durable_archive({"status": "skipped", "record_id": None, "reason": "insert-failed: X"})
        with self.assertRaises(EngineError):
            require_durable_archive({"status": "inserted", "record_id": None})
        self.assertEqual(
            require_durable_archive({"status": "inserted", "record_id": "abc"}),
            {"status": "inserted", "record_id": "abc"},
        )
        self.assertEqual(
            require_durable_archive({"status": "reinforced", "record_id": "abc"}),
            {"status": "reinforced", "record_id": "abc"},
        )

    def test_scope_filter_uses_durable_key_tags(self) -> None:
        from iai_bridge_server import IaiEngine

        class StubRecord:
            def __init__(self, tags):
                self.tags = tags

        class FakeStore:
            def get(self, _record_id):
                return StubRecord(["bridge-archive", "bank:qb", "project:qp", "key:qk"])

        engine = IaiEngine.__new__(IaiEngine)
        engine._store = FakeStore()  # type: ignore[attr-defined]
        rid = "12345678-1234-5678-1234-567812345678"
        self.assertEqual(engine._scoped_bridge_key(rid, {"bank:qb", "project:qp"}), "qk")
        self.assertIsNone(engine._scoped_bridge_key(rid, {"bank:other", "project:qp"}))

    def test_token_file_missing_denies(self) -> None:
        lonely = BridgeServer(token_file=os.path.join(self.tmp.name, "nope.json"), engine=MemoryEngine())
        reply = _frame(lonely, "health", {})
        self.assertEqual(reply["kind"], "error")
        self.assertEqual(reply["body"]["code"], "unauthorized")


if __name__ == "__main__":
    unittest.main(verbosity=2)
