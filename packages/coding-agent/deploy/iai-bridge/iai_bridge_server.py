#!/usr/bin/env python3
"""IAI long-term memory bridge server (v1 protocol).

Listens on TCP (loopback by default) and serves newline-delimited JSON
envelopes compatible with the PrimePi TypeScript client
(`iai-bridge-protocol.ts`). Archive writes and recall go through the real
IAI engine (`iai_mcp.core.dispatch`) against the store at IAI_MCP_STORE.

Security:
  - Bearer token verified (constant time) BEFORE any memory operation.
  - Non-loopback binds require TLS; wildcard binds are refused at startup.
  - Request sizes bounded; malformed frames get error envelopes, never a crash.
  - Token values are never logged.

Usage:
    IAI_MCP_STORE=/srv/buster/iai-memory python3 iai_bridge_server.py \
        --config /srv/buster/iai-memory/bridge-config.toml
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import socket
import socketserver
import ssl
import threading
from dataclasses import dataclass, field
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11 (not expected on targets)
    tomllib = None  # type: ignore[assignment]

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_CONTENT_CHARS = 262_144
MAX_RECALL_QUERY_CHARS = 2000
MAX_RECALL_LIMIT = 50

MESSAGE_KINDS = frozenset(
    {
        "archive",
        "archive-ack",
        "recall",
        "recall-result",
        "health",
        "health-result",
        "error",
    }
)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def parse_envelope(frame: str) -> tuple[dict | None, str | None]:
    """Parse and structurally validate one frame. Returns (envelope, error)."""
    try:
        parsed = json.loads(frame)
    except json.JSONDecodeError:
        return None, "invalid-json"
    if not _is_record(parsed):
        return None, "invalid-envelope"
    if parsed.get("v") != PROTOCOL_VERSION:
        return None, "unsupported-version"
    if not isinstance(parsed.get("id"), str) or not parsed["id"]:
        return None, "invalid-id"
    if parsed.get("kind") not in MESSAGE_KINDS:
        return None, "invalid-kind"
    if not isinstance(parsed.get("auth"), str):
        return None, "invalid-auth"
    body = parsed.get("body")
    if body is not None and not _is_record(body):
        return None, "invalid-body"
    return parsed, None


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def validate_archive_body(body: Any) -> str | None:
    if not _is_record(body):
        return "invalid-body"
    for field_name in ("key", "bank", "projectId", "sessionId", "contentHash", "idempotencyKey"):
        if not _nonempty_str(body.get(field_name)):
            return f"missing-{field_name}"
    if not isinstance(body.get("bytes"), (int, float)) or body["bytes"] < 0:
        return "invalid-bytes"
    if not isinstance(body.get("version"), int) or body["version"] < 0:
        return "invalid-version"
    content = body.get("content")
    if content is not None:
        if not isinstance(content, str) or len(content) > MAX_ARCHIVE_CONTENT_CHARS:
            return "invalid-content"
        claimed = body.get("contentHash")
        actual = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if claimed != actual:
            return "hash-mismatch"
    return None


def validate_recall_body(body: Any) -> str | None:
    if not _is_record(body):
        return "invalid-body"
    query = body.get("query")
    if not isinstance(query, str) or not query or len(query) > MAX_RECALL_QUERY_CHARS:
        return "invalid-query"
    if not _nonempty_str(body.get("bank")) or not _nonempty_str(body.get("projectId")):
        return "invalid-scope"
    limit = body.get("limit")
    if not isinstance(limit, int) or limit < 1 or limit > MAX_RECALL_LIMIT:
        return "invalid-limit"
    return None


@dataclass
class TokenSet:
    active: str = ""
    previous: str | None = None
    rotated_at: str | None = None


def load_token_set(path: str) -> TokenSet:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return TokenSet()
    if not isinstance(data, dict) or not isinstance(data.get("active"), str):
        return TokenSet()
    previous = data.get("previous")
    rotated_at = data.get("rotatedAt")
    return TokenSet(
        active=data["active"],
        previous=previous if isinstance(previous, str) else None,
        rotated_at=rotated_at if isinstance(rotated_at, str) else None,
    )


def token_accepted(provided: str, tokens: TokenSet) -> bool:
    """Accept the active token, or the previous token (rotation grace)."""
    candidates = [tokens.active] + ([tokens.previous] if tokens.previous else [])
    for candidate in candidates:
        if not candidate:
            continue
        if len(provided) != len(candidate):
            continue
        if hmac.compare_digest(provided.encode("utf-8"), candidate.encode("utf-8")):
            return True
    return False


class EngineError(RuntimeError):
    pass


def require_durable_archive(result: Any) -> dict:
    """Accept only genuinely persisted captures as durable.

    `capture_turn` reports {status, record_id, reason}: `inserted` and
    `reinforced` (dedup hit) with a record id count. `skipped` for any
    reason — including insert failures — must never be acknowledged.
    """
    if not isinstance(result, dict):
        raise EngineError("engine returned malformed archive result")
    if result.get("status") not in ("inserted", "reinforced") or not result.get("record_id"):
        raise EngineError(f"engine did not persist archive: {result!r}"[:500])
    return result


class Engine:
    """Storage interface. Production path uses the real IAI engine."""

    def archive(self, body: dict) -> dict:
        raise NotImplementedError

    def recall(self, body: dict) -> dict:
        raise NotImplementedError


class IaiEngine(Engine):
    """Real IAI engine backend: one shared store, one lock, real dispatch."""

    def __init__(self) -> None:
        try:
            from iai_mcp.store import MemoryStore
        except ImportError as exc:
            raise EngineError(f"iai_mcp is not installed: {exc}") from exc
        self._store = MemoryStore()
        self._lock = threading.Lock()

    def archive(self, body: dict) -> dict:
        try:
            from iai_mcp.core import dispatch
        except ImportError as exc:
            raise EngineError(f"iai_mcp.core is unavailable: {exc}") from exc
        content = body.get("content")
        if not isinstance(content, str) or not content:
            raise EngineError("archive requires content")
        params = {
            "cue": body["key"],
            "text": content,
            "tier": "episodic",
            "session_id": body.get("sessionId", "-"),
            "provenance_extra": {
                "bridge": True,
                "bank": body.get("bank"),
                "project_id": body.get("projectId"),
                "idempotency_key": body.get("idempotencyKey"),
            },
            "extra_tags": ["bridge-archive", f"bank:{body.get('bank')}", f"project:{body.get('projectId')}"],
        }
        with self._lock:
            result = dispatch(self._store, "memory_capture", params)
        return require_durable_archive(result)

    def recall(self, body: dict) -> dict:
        try:
            from iai_mcp.core import dispatch
        except ImportError as exc:
            raise EngineError(f"iai_mcp.core is unavailable: {exc}") from exc
        params = {
            "query": body["query"],
            "bank": body.get("bank"),
            "limit": body.get("limit", 10),
        }
        with self._lock:
            result = dispatch(self._store, "memory_search", params)
        if not isinstance(result, dict):
            raise EngineError("engine returned malformed recall result")
        return result


class MemoryEngine(Engine):
    """In-memory engine for unit tests (never touches a real store)."""

    def __init__(self) -> None:
        self.records: dict[str, dict] = {}
        self.fail_next: str | None = None

    def archive(self, body: dict) -> dict:
        if self.fail_next:
            message, self.fail_next = self.fail_next, None
            raise EngineError(message)
        record = {
            "key": body["key"],
            "bank": body.get("bank"),
            "project_id": body.get("projectId"),
            "content": body.get("content", ""),
        }
        self.records[body["key"]] = record
        return {"ok": True, "key": body["key"]}

    def recall(self, body: dict) -> dict:
        if self.fail_next:
            message, self.fail_next = self.fail_next, None
            raise EngineError(message)
        bank = body.get("bank")
        project = body.get("projectId")
        items = []
        for key, record in self.records.items():
            if bank is not None and record.get("bank") != bank:
                continue
            if project is not None and record.get("project_id") != project:
                continue
            snippet = str(record.get("content", ""))[:500]
            if body["query"][:24].lower() in snippet.lower():
                items.append({"key": key, "snippet": snippet, "score": 1.0})
            if len(items) >= body.get("limit", 10):
                break
        return {"results": items}


@dataclass
class BridgeServer:
    token_file: str
    engine: Engine
    pending_acks: dict = field(default_factory=dict)

    def handle_frame(self, frame: str) -> dict:
        envelope, error = parse_envelope(frame)
        if error is not None or envelope is None:
            return self._error("unknown", error or "invalid-frame", "Malformed request frame.")
        tokens = load_token_set(self.token_file)
        if not token_accepted(envelope["auth"], tokens):
            return self._error(envelope["id"], "unauthorized", "Bad or missing bearer token.")
        kind = envelope["kind"]
        body = envelope.get("body")
        try:
            if kind == "health":
                return self._reply(envelope["id"], "health-result", {"ok": True, "version": 1, "pendingWrites": 0})
            if kind == "archive":
                return self._handle_archive(envelope["id"], body)
            if kind == "recall":
                return self._handle_recall(envelope["id"], body)
            return self._error(envelope["id"], "unsupported-kind", f"Unsupported kind: {kind}")
        except EngineError as exc:
            return self._error(envelope["id"], "engine-unavailable", str(exc)[:500])
        except Exception as exc:  # Never crash the server on a bad request.
            return self._error(envelope["id"], "internal-error", f"{type(exc).__name__}"[:200])

    def _handle_archive(self, req_id: str, body: Any) -> dict:
        problem = validate_archive_body(body)
        if problem is not None:
            return self._error(req_id, problem, "Archive body failed validation.")
        idem = body["idempotencyKey"]
        if idem in self.pending_acks:
            ack = dict(self.pending_acks[idem])
            ack["duplicate"] = True
            return self._reply(req_id, "archive-ack", ack)
        ack_body = self.engine.archive(body)
        ack = {
            "key": body["key"],
            "idempotencyKey": idem,
            "durable": True,
            "storedAt": body.get("storedAt") or "",
            "engine": ack_body if isinstance(ack_body, dict) else {},
        }
        self.pending_acks[idem] = {k: v for k, v in ack.items() if k != "duplicate"}
        return self._reply(req_id, "archive-ack", ack)

    def _handle_recall(self, req_id: str, body: Any) -> dict:
        problem = validate_recall_body(body)
        if problem is not None:
            return self._error(req_id, problem, "Recall body failed validation.")
        result = self.engine.recall(body)
        results = result.get("results", []) if isinstance(result, dict) else []
        items = [
            {"key": r.get("key", ""), "snippet": str(r.get("snippet", r.get("content", "")))[:500],
             "score": float(r.get("score", 0.0))}
            for r in results[: body.get("limit", 10)]
            if isinstance(r, dict)
        ]
        return self._reply(req_id, "recall-result", {"items": items, "truncated": len(results) > len(items)})

    def _reply(self, req_id: str, kind: str, body: dict) -> dict:
        return {"v": PROTOCOL_VERSION, "id": req_id, "kind": kind, "auth": "", "body": body}

    def _error(self, req_id: str, code: str, message: str) -> dict:
        return {"v": PROTOCOL_VERSION, "id": req_id, "kind": "error", "auth": "",
                "body": {"code": code, "message": message}}


def load_config(path: str) -> dict:
    if tomllib is None:
        raise SystemExit("tomllib is unavailable (Python 3.11+ required)")
    with open(path, "rb") as handle:
        config = tomllib.load(handle)
    server = config.get("server", {}) if isinstance(config, dict) else {}
    bind = str(server.get("bind", "127.0.0.1"))
    port = int(server.get("port", 8420))
    if bind in ("0.0.0.0", "::"):
        raise SystemExit("refusing wildcard bind; use loopback or one explicit address")
    tls_cfg = config.get("tls", {}) if isinstance(config, dict) else {}
    cert = tls_cfg.get("cert_path") if isinstance(tls_cfg, dict) else None
    key = tls_cfg.get("key_path") if isinstance(tls_cfg, dict) else None
    loopback = bind in ("127.0.0.1", "::1", "localhost")
    if not loopback and (not cert or not key):
        raise SystemExit("non-loopback binds require [tls] cert_path and key_path")
    return {"bind": bind, "port": port, "cert": cert, "key": key}


def serve_forever(config_path: str, token_file: str) -> None:
    config = load_config(config_path)
    engine = IaiEngine()
    server_logic = BridgeServer(token_file=token_file, engine=engine)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            try:
                raw = self.rfile.readline(MAX_FRAME_BYTES + 1024)
            except (OSError, ValueError):
                return
            if not raw:
                return
            if len(raw) > MAX_FRAME_BYTES + 1:
                reply = server_logic.handle_frame("")
            else:
                try:
                    reply = server_logic.handle_frame(raw.decode("utf-8").strip())
                except UnicodeDecodeError:
                    reply = server_logic.handle_frame("")
            try:
                self.wfile.write((json.dumps(reply) + "\n").encode("utf-8"))
            except (OSError, ValueError):
                return

    with socketserver.ThreadingTCPServer((config["bind"], config["port"]), Handler) as httpd:
        httpd.daemon_threads = True
        httpd.allow_reuse_address = True
        if config["cert"]:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(config["cert"], config["key"])
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        print(f"iai-bridge listening on {config['bind']}:{config['port']}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="IAI long-term memory bridge server.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--token-file", default=None)
    args = parser.parse_args(argv)
    token_file = args.token_file or "/srv/buster/iai-memory/.bridge-token"
    serve_forever(args.config, token_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
