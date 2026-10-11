import { describe, expect, it } from "bun:test";
import { normalizeRecallHits, normalizeSearchHits } from "../../src/memory-backend/iai-client";

describe("iai client normalization", () => {
	it("maps recall hits to PrimePi rows", () => {
		const rows = normalizeRecallHits({
			hits: [
				{ record_id: "a", literal_surface: "alpha", score: 0.9, captured_at: "2026-01-01" },
				{ record_id: "", literal_surface: "dropped" },
				"garbage",
			],
		});
		expect(rows).toEqual([{ id: "a", content: "alpha", score: 0.9, timestamp: "2026-01-01" }]);
	});

	it("maps search hits to PrimePi rows", () => {
		const rows = normalizeSearchHits({
			frame: "hybrid",
			hits: [
				{ record_id: "b", surface: "beta", tier: "episodic", lane: "lexical", score: 2.5 },
				{ record_id: "c", surface: "gamma", cos: 0.7 },
			],
		});
		expect(rows).toEqual([
			{ id: "b", content: "beta", score: 2.5 },
			{ id: "c", content: "gamma", score: 0.7 },
		]);
	});

	it("returns empty rows for malformed responses", () => {
		expect(normalizeRecallHits(null)).toEqual([]);
		expect(normalizeRecallHits({})).toEqual([]);
		expect(normalizeSearchHits({ hits: "nope" })).toEqual([]);
	});
});
