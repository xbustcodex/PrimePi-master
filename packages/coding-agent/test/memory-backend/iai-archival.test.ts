import { describe, expect, it } from "bun:test";
import {
	confirmArchived,
	createArchivalRecord,
	dequeuePendingWrite,
	enqueueForArchive,
	enqueuePendingWrite,
	isEvictable,
	markCacheEligible,
	parsePendingQueue,
	serializePendingQueue,
} from "../../src/memory-backend/iai-archival";

describe("iai archival lifecycle", () => {
	it("walks active -> pending -> confirmed -> cache-eligible", () => {
		const active = createArchivalRecord("mem-1");
		const pending = enqueueForArchive(active, "idem-1");
		expect("error" in pending).toBe(false);
		if ("error" in pending) return;
		expect(isEvictable(pending)).toBe(false);

		const confirmed = confirmArchived(pending, "idem-1");
		expect("error" in confirmed).toBe(false);
		if ("error" in confirmed) return;
		expect(isEvictable(confirmed)).toBe(false);

		const eligible = markCacheEligible(confirmed);
		expect("error" in eligible).toBe(false);
		if ("error" in eligible) return;
		expect(isEvictable(eligible)).toBe(true);
	});

	it("never evicts before durable acknowledgement", () => {
		const active = createArchivalRecord("mem-2");
		expect(isEvictable(active)).toBe(false);
		expect("error" in markCacheEligible(active)).toBe(true);

		const pending = enqueueForArchive(active, "idem-2");
		if ("error" in pending) return;
		expect(isEvictable(pending)).toBe(false);
		expect("error" in markCacheEligible(pending)).toBe(true);
	});

	it("rejects mismatched idempotency keys and duplicate acks", () => {
		const pending = enqueueForArchive(createArchivalRecord("mem-3"), "idem-3");
		if ("error" in pending) return;
		expect("error" in confirmArchived(pending, "wrong-key")).toBe(true);

		const confirmed = confirmArchived(pending, "idem-3");
		if ("error" in confirmed) return;
		// Duplicate ack after confirmation is an invalid transition, not a second write.
		expect("error" in confirmArchived(confirmed, "idem-3")).toBe(true);
	});

	it("keeps the pending queue idempotent and serializable", () => {
		const q1 = enqueuePendingWrite([], "mem-4", "idem-4");
		const q2 = enqueuePendingWrite(q1, "mem-4", "idem-4");
		expect(q2.length).toBe(1);
		const restored = parsePendingQueue(serializePendingQueue(q2));
		expect(restored).toEqual(q2);
		expect(dequeuePendingWrite(restored, "mem-4").length).toBe(0);
		expect(parsePendingQueue("garbage").length).toBe(0);
	});
});
