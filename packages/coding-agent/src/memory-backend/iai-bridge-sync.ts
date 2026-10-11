/**
 * Automatic synchronization between PrimePi sessions and Linux long-term
 * memory over the authenticated bridge.
 *
 * - Eligible learned knowledge is redacted (existing `redactMemorySecrets`)
 *   and appended to a durable JSONL queue under the agent directory, so a
 *   Windows restart never loses pending archival work.
 * - `drainQueue` sends pending entries through the tunnel and removes each
 *   one only after a durable acknowledgement. Any transport failure is
 *   fail-open: the agent keeps working and the entry stays queued.
 * - Remote recall is explicit and bounded; recalled items carry bridge
 *   provenance so the model never mistakes archive metadata for instruction.
 * - Local-memory eviction is never performed here.
 */
import { appendFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { redactMemorySecrets } from "./redact";

export type IaiSyncEntryState = "pending" | "acked";

export interface IaiSyncEntry {
	key: string;
	bank: string;
	projectId: string;
	sessionId: string;
	contentHash: string;
	bytes: number;
	idempotencyKey: string;
	version: number;
	content: string;
	state: IaiSyncEntryState;
	attempts: number;
}

export interface IaiSyncEnqueueInput {
	key: string;
	bank: string;
	projectId: string;
	sessionId: string;
	content: string;
}

export interface IaiSyncAck {
	durable: boolean;
	duplicate?: boolean;
}

export interface IaiSyncDrainResult {
	acked: string[];
	remaining: number;
	failed: string[];
}

/** Durable queue file inside the agent directory (never inside a project). */
export function syncQueuePath(agentDir: string): string {
	const trimmed = agentDir.endsWith("/") ? agentDir.slice(0, -1) : agentDir;
	return `${trimmed}/iai-bridge-queue.jsonl`;
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseLine(line: string): IaiSyncEntry | undefined {
	if (!line.trim()) return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (
			typeof record.key !== "string" ||
			typeof record.bank !== "string" ||
			typeof record.projectId !== "string" ||
			typeof record.sessionId !== "string" ||
			typeof record.contentHash !== "string" ||
			typeof record.bytes !== "number" ||
			typeof record.idempotencyKey !== "string" ||
			typeof record.version !== "number" ||
			typeof record.content !== "string" ||
			typeof record.attempts !== "number"
		) {
			return undefined;
		}
		return {
			key: record.key,
			bank: record.bank,
			projectId: record.projectId,
			sessionId: record.sessionId,
			contentHash: record.contentHash,
			bytes: record.bytes,
			idempotencyKey: record.idempotencyKey,
			version: record.version,
			content: record.content,
			state: record.state === "acked" ? "acked" : "pending",
			attempts: record.attempts,
		};
	} catch {
		return undefined;
	}
}

/** Read the durable queue, skipping corrupt lines. */
export async function readSyncQueue(walPath: string): Promise<{ entries: IaiSyncEntry[]; corrupt: number }> {
	let raw: string;
	try {
		raw = await Bun.file(walPath).text();
	} catch {
		return { entries: [], corrupt: 0 };
	}
	const entries: IaiSyncEntry[] = [];
	let corrupt = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const entry = parseLine(line);
		if (entry) entries.push(entry);
		else corrupt++;
	}
	return { entries, corrupt };
}

async function rewriteSyncQueue(walPath: string, entries: readonly IaiSyncEntry[]): Promise<void> {
	const body = entries.map(entry => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "");
	await writeFile(`${walPath}.tmp`, body, "utf8");
	await rename(`${walPath}.tmp`, walPath);
}

/**
 * Enqueue eligible learned knowledge for archival. Secrets are redacted
 * before anything touches disk; the idempotency key binds this exact
 * payload so retries never fork duplicates.
 */
export async function enqueueSync(walPath: string, input: IaiSyncEnqueueInput): Promise<IaiSyncEntry> {
	const content = redactMemorySecrets(input.content);
	const entry: IaiSyncEntry = {
		key: input.key,
		bank: input.bank,
		projectId: input.projectId,
		sessionId: input.sessionId,
		contentHash: sha256Hex(content),
		bytes: content.length,
		idempotencyKey: randomUUID(),
		version: 0,
		content,
		state: "pending",
		attempts: 0,
	};
	await appendFile(walPath, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

export type SyncTransport = (entry: IaiSyncEntry) => Promise<IaiSyncAck>;

/**
 * Drain pending entries through the bridge. Each entry is removed only
 * after a durable acknowledgement; transport failures keep the entry with
 * a bumped attempt count. Never throws: an unavailable memory service
 * must not break the agent loop.
 */
export async function drainSyncQueue(
	walPath: string,
	transport: SyncTransport,
	options?: { maxEntries?: number },
): Promise<IaiSyncDrainResult> {
	const { entries } = await readSyncQueue(walPath);
	const pending = entries.filter(entry => entry.state === "pending");
	const budget = options?.maxEntries ?? pending.length;
	const acked: string[] = [];
	const failed: string[] = [];
	let remaining = pending.length;
	const kept: IaiSyncEntry[] = entries.filter(entry => entry.state !== "pending");

	for (const entry of pending.slice(0, budget)) {
		try {
			const ack = await transport(entry);
			if (ack?.durable === true) {
				acked.push(entry.key);
				remaining--;
			} else {
				failed.push(entry.key);
				kept.push({ ...entry, attempts: entry.attempts + 1 });
			}
		} catch {
			failed.push(entry.key);
			kept.push({ ...entry, attempts: entry.attempts + 1 });
		}
	}
	for (const entry of pending.slice(budget)) kept.push(entry);
	await rewriteSyncQueue(walPath, kept);
	return { acked, remaining, failed };
}

export interface IaiRemoteRecallItem {
	key?: string;
	bridgeKey?: string;
	snippet: string;
	score: number;
}

export type RecallTransport = (input: {
	query: string;
	bank: string;
	projectId: string;
	limit: number;
}) => Promise<{ items: IaiRemoteRecallItem[] }>;

export const REMOTE_RECALL_MAX_LIMIT = 10;

/**
 * Bounded remote recall with bridge provenance. The limit is capped so a
 * single recall can never flood the context; every item keeps the bank it
 * was verified against.
 */
export async function recallRemote(
	transport: RecallTransport,
	input: { query: string; bank: string; projectId: string; limit?: number },
): Promise<Array<IaiRemoteRecallItem & { provenance: string }>> {
	const limit = Math.max(1, Math.min(input.limit ?? 5, REMOTE_RECALL_MAX_LIMIT));
	const result = await transport({ query: input.query, bank: input.bank, projectId: input.projectId, limit });
	return result.items.slice(0, limit).map(item => ({
		...item,
		provenance: `bridge:archived:${input.bank}`,
	}));
}
