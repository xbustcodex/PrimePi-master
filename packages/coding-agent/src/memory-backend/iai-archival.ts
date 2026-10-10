/**
 * IAI archival lifecycle for distributed long-term memory.
 *
 * States: active -> pending-archive -> archived-confirmed -> cache-eligible.
 *
 * A memory must never become eligible for local eviction until the remote
 * copy is durably acknowledged (matching idempotency key) and explicitly
 * marked cache-eligible after verification. This module is pure: no network,
 * no filesystem. The durable pending-write queue serializes to JSON so a
 * write-ahead log can persist it without depending on this module for I/O.
 */

export type IaiArchivalState = "active" | "pending-archive" | "archived-confirmed" | "cache-eligible";

export interface IaiArchivalRecord {
	key: string;
	state: IaiArchivalState;
	idempotencyKey: string | null;
	version: number;
	updatedAt: string;
}

export interface IaiPendingWrite {
	key: string;
	idempotencyKey: string;
	enqueuedAt: string;
	attempts: number;
}

export type ArchivalTransitionError =
	| "unknown-record"
	| "invalid-transition"
	| "idempotency-mismatch"
	| "not-confirmed";

function nowIso(): string {
	return new Date().toISOString();
}

/** Create a fresh active record. */
export function createArchivalRecord(key: string): IaiArchivalRecord {
	return { key, state: "active", idempotencyKey: null, version: 0, updatedAt: nowIso() };
}

/** Enqueue a record for archival: active -> pending-archive. Idempotent. */
export function enqueueForArchive(
	record: IaiArchivalRecord,
	idempotencyKey: string,
): IaiArchivalRecord | { error: ArchivalTransitionError } {
	if (record.state === "pending-archive" && record.idempotencyKey === idempotencyKey) return record;
	if (record.state !== "active") return { error: "invalid-transition" };
	if (idempotencyKey.length === 0) return { error: "invalid-transition" };
	return {
		key: record.key,
		state: "pending-archive",
		idempotencyKey,
		version: record.version + 1,
		updatedAt: nowIso(),
	};
}

/** Confirm durable remote storage: pending-archive -> archived-confirmed. */
export function confirmArchived(
	record: IaiArchivalRecord,
	idempotencyKey: string,
): IaiArchivalRecord | { error: ArchivalTransitionError } {
	if (record.state !== "pending-archive") return { error: "invalid-transition" };
	if (record.idempotencyKey !== idempotencyKey) return { error: "idempotency-mismatch" };
	return {
		key: record.key,
		state: "archived-confirmed",
		idempotencyKey,
		version: record.version + 1,
		updatedAt: nowIso(),
	};
}

/** Mark verified records evictable locally: archived-confirmed -> cache-eligible. */
export function markCacheEligible(record: IaiArchivalRecord): IaiArchivalRecord | { error: ArchivalTransitionError } {
	if (record.state !== "archived-confirmed") return { error: "not-confirmed" };
	return {
		key: record.key,
		state: "cache-eligible",
		idempotencyKey: record.idempotencyKey,
		version: record.version + 1,
		updatedAt: nowIso(),
	};
}

/** Whether a record may be evicted from the local active store. */
export function isEvictable(record: IaiArchivalRecord): boolean {
	return record.state === "cache-eligible";
}

/** Add a pending write (deduplicated by key; retries bump attempts). */
export function enqueuePendingWrite(
	queue: readonly IaiPendingWrite[],
	key: string,
	idempotencyKey: string,
): IaiPendingWrite[] {
	const existing = queue.find(entry => entry.key === key);
	if (existing) {
		if (existing.idempotencyKey === idempotencyKey) return [...queue];
		return queue.map(entry =>
			entry.key === key ? { ...entry, idempotencyKey, attempts: entry.attempts + 1 } : entry,
		);
	}
	return [...queue, { key, idempotencyKey, enqueuedAt: nowIso(), attempts: 0 }];
}

/** Remove a pending write after its durable acknowledgement. */
export function dequeuePendingWrite(queue: readonly IaiPendingWrite[], key: string): IaiPendingWrite[] {
	return queue.filter(entry => entry.key !== key);
}

/** Serialize the pending queue for a durable write-ahead log. */
export function serializePendingQueue(queue: readonly IaiPendingWrite[]): string {
	return JSON.stringify(queue);
}

/** Restore a pending queue from a write-ahead log. Invalid entries are dropped. */
export function parsePendingQueue(raw: string): IaiPendingWrite[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: IaiPendingWrite[] = [];
	for (const entry of parsed) {
		if (
			entry !== null &&
			typeof entry === "object" &&
			typeof (entry as { key?: unknown }).key === "string" &&
			typeof (entry as { idempotencyKey?: unknown }).idempotencyKey === "string" &&
			typeof (entry as { enqueuedAt?: unknown }).enqueuedAt === "string" &&
			typeof (entry as { attempts?: unknown }).attempts === "number"
		) {
			const typed = entry as IaiPendingWrite;
			if (typed.key.length > 0 && typed.idempotencyKey.length > 0) out.push(typed);
		}
	}
	return out;
}
