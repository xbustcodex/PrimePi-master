import { describe, expect, it } from "bun:test";
import { withWatchdogFetch } from "../src/utils/stream-watchdog";

describe("watchdog integration", () => {
	it("interrupts a stalled response body", async () => {
		const stalledBody = new ReadableStream<Uint8Array>({
			start() {
				// never emit; stall indefinitely
			},
		});
		const baseFetch = async () => new Response(stalledBody, { status: 200 });
		const guarded = withWatchdogFetch(baseFetch as unknown as typeof globalThis.fetch, {
			firstEventTimeoutMs: 150,
			idleTimeoutMs: 150,
		});
		expect(guarded).not.toBeNull();
		const res = await guarded!("http://test");
		const reader = res.body!.getReader();
		try {
			await reader.read();
			expect(true).toBe(false); // should have thrown
		} catch (e: any) {
			expect(e?.message ?? "").toContain("watchdog");
		} finally {
			reader.releaseLock();
		}
	});
});
