import { describe, expect, it } from "bun:test";
import {
	emptyTokenSet,
	expirePreviousToken,
	generateBridgeToken,
	hasActiveToken,
	parseTokenSet,
	previousTokenValid,
	rotateBridgeToken,
	serializeTokenSet,
} from "../../src/memory-backend/iai-bridge-auth";

describe("iai bridge auth", () => {
	it("generates URL-safe tokens of the expected entropy", () => {
		const a = generateBridgeToken();
		const b = generateBridgeToken();
		expect(a.length).toBeGreaterThan(60);
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
	});

	it("keeps the previous token through rotation, then expires it", () => {
		const initial = { active: "token-one", previous: null, rotatedAt: null };
		const rotated = rotateBridgeToken(initial, "token-two", "2026-10-10T00:00:00.000Z");
		expect(hasActiveToken(rotated)).toBe(true);
		expect(previousTokenValid(rotated, Date.parse("2026-10-10T12:00:00.000Z"))).toBe(true);
		expect(previousTokenValid(rotated, Date.parse("2026-10-12T00:00:01.000Z"))).toBe(false);

		const expired = expirePreviousToken(rotated, Date.parse("2026-10-12T00:00:01.000Z"));
		expect(expired.previous).toBeNull();
		expect(expired.active).toBe("token-two");
	});

	it("round-trips the restricted token file and rejects corruption", () => {
		const set = rotateBridgeToken({ active: "a", previous: null, rotatedAt: null }, "b");
		expect(parseTokenSet(serializeTokenSet(set))).toEqual(set);
		expect(parseTokenSet("garbage")).toEqual(emptyTokenSet());
		expect(hasActiveToken(emptyTokenSet())).toBe(false);
	});
});
