import { describe, expect, it } from "bun:test";
import {
	buildBridgeEnvelope,
	parseBridgeEnvelope,
	serializeBridgeEnvelope,
	validateArchiveBody,
	validateRecallBody,
	verifyBridgeToken,
} from "../../src/memory-backend/iai-bridge-protocol";

describe("iai bridge protocol", () => {
	it("round-trips an archive envelope", () => {
		const envelope = buildBridgeEnvelope({
			id: "req-1",
			kind: "archive",
			auth: "token-abc",
			body: {
				key: "mem-1",
				bank: "project-x",
				projectId: "x",
				sessionId: "s",
				contentHash: "abc123",
				bytes: 42,
				idempotencyKey: "idem-1",
				version: 0,
			},
		});
		const parsed = parseBridgeEnvelope(serializeBridgeEnvelope(envelope).trim());
		expect(parsed.ok).toBe(true);
		expect(parsed.envelope?.kind).toBe("archive");
		expect(validateArchiveBody(parsed.envelope?.body)).toBe(true);
	});

	it("rejects unauthenticated callers", () => {
		expect(verifyBridgeToken("wrong", "expected-token")).toBe(false);
		expect(verifyBridgeToken("expected-token", "expected-token")).toBe(true);
		expect(verifyBridgeToken("short", "much-longer-expected")).toBe(false);
	});

	it("rejects malformed frames", () => {
		expect(parseBridgeEnvelope("not-json").ok).toBe(false);
		expect(parseBridgeEnvelope(JSON.stringify({ v: 999, id: "x", kind: "archive", auth: "", body: {} })).ok).toBe(
			false,
		);
		expect(parseBridgeEnvelope(JSON.stringify({ v: 1, id: "", kind: "archive", auth: "", body: {} })).ok).toBe(false);
	});

	it("bounds recall limits", () => {
		expect(validateRecallBody({ query: "q", bank: "b", projectId: "p", limit: 10 })).toBe(true);
		expect(validateRecallBody({ query: "", bank: "b", projectId: "p", limit: 10 })).toBe(false);
		expect(validateRecallBody({ query: "q", bank: "b", projectId: "p", limit: 500 })).toBe(false);
	});
});
