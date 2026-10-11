import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	drainSyncQueue,
	enqueueSync,
	readSyncQueue,
	recallRemote,
	syncQueuePath,
} from "../../src/memory-backend/iai-bridge-sync";

let dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	dirs = [];
});

async function tempWal(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iai-sync-"));
	dirs.push(dir);
	return syncQueuePath(dir);
}

describe("iai bridge sync", () => {
	it("survives a Windows restart via the durable queue file", async () => {
		const wal = await tempWal();
		await enqueueSync(wal, {
			key: "lesson-1",
			bank: "proj",
			projectId: "proj",
			sessionId: "s1",
			content: "Verified fix: restart the bridge before rebinding the port.",
		});
		// Fresh reader, as after a process restart.
		const { entries, corrupt } = await readSyncQueue(wal);
		expect(corrupt).toBe(0);
		expect(entries.map(entry => entry.key)).toEqual(["lesson-1"]);
		expect(entries[0]?.state).toBe("pending");
	});

	it("redacts secrets before anything touches disk", async () => {
		const wal = await tempWal();
		await enqueueSync(wal, {
			key: "lesson-2",
			bank: "proj",
			projectId: "proj",
			sessionId: "s1",
			content: "Deploy with AKIAIOSFODNN7EXAMPLE exposed in the example.",
		});
		const raw = await Bun.file(wal).text();
		expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(raw).toContain("[REDACTED]");
	});

	it("removes entries only on durable acks and keeps failures queued", async () => {
		const wal = await tempWal();
		await enqueueSync(wal, { key: "ok", bank: "b", projectId: "b", sessionId: "s", content: "stays" });
		await enqueueSync(wal, { key: "down", bank: "b", projectId: "b", sessionId: "s", content: "retried" });
		const result = await drainSyncQueue(wal, async entry => {
			if (entry.key === "ok") return { durable: true };
			throw new Error("tunnel down");
		});
		expect(result).toEqual({ acked: ["ok"], remaining: 1, failed: ["down"] });
		const { entries } = await readSyncQueue(wal);
		expect(entries.map(entry => entry.key)).toEqual(["down"]);
		expect(entries[0]?.attempts).toBe(1);
	});

	it("bounds remote recall and stamps bridge provenance", async () => {
		const items = await recallRemote(
			async () => ({ items: Array.from({ length: 30 }, (_, i) => ({ snippet: `m${i}`, score: 1 })) }),
			{ query: "q", bank: "proj", projectId: "proj", limit: 99 },
		);
		expect(items.length).toBe(10);
		expect(items[0]?.provenance).toBe("bridge:archived:proj");
	});
});
