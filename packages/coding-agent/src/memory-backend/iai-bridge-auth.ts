/**
 * Bearer-token provisioning for the IAI long-term memory bridge.
 *
 * Design:
 * - Tokens are generated server-side from a cryptographically secure random
 *   source (WebCrypto) and stored in a restricted file (0600) outside the
 *   repository, e.g. `/srv/buster/iai-memory/.bridge-token`.
 * - Rotation keeps the previous token valid during a grace window so an
 *   in-flight Windows client is not locked out mid-sync; the client retries
 *   once with the freshly provisioned token on an auth rejection.
 * - Windows provisioning is operator-mediated: the operator copies the token
 *   file over the existing authenticated SSH session into the Windows
 *   credential path (`%APPDATA%/omp/iai-bridge-token`, restricted ACLs).
 *   Tokens are never committed to Git, never logged, and never sent over an
 *   unencrypted connection (see `iai-bridge-transport.ts`).
 *
 * This module is pure apart from token generation: file I/O lives with the
 * caller so the rotation rules stay unit-testable without touching secrets.
 */

export const BRIDGE_TOKEN_BYTES = 48;
export const BRIDGE_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

export interface BridgeTokenSet {
	active: string;
	previous: string | null;
	rotatedAt: string | null;
}

/** Generate a fresh bearer token (base64url, 48 random bytes). */
export function generateBridgeToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(BRIDGE_TOKEN_BYTES));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Blank initial token set (no credentials). */
export function emptyTokenSet(): BridgeTokenSet {
	return { active: "", previous: null, rotatedAt: null };
}

/** Whether a token set can authenticate (an active token is present). */
export function hasActiveToken(set: BridgeTokenSet): boolean {
	return set.active.length > 0;
}

/**
 * Rotate credentials: the current active token becomes `previous` for the
 * grace window, and `next` becomes active. Returns the new set; the caller
 * persists it to the restricted token file.
 */
export function rotateBridgeToken(set: BridgeTokenSet, next: string, nowIso?: string): BridgeTokenSet {
	if (next.length === 0) return set;
	return {
		active: next,
		previous: set.active.length > 0 ? set.active : null,
		rotatedAt: nowIso ?? new Date().toISOString(),
	};
}

/** Whether `previous` is still within its grace window at `nowMs`. */
export function previousTokenValid(set: BridgeTokenSet, nowMs: number): boolean {
	if (set.previous === null || set.previous.length === 0) return false;
	if (set.rotatedAt === null) return true;
	const rotatedAtMs = Date.parse(set.rotatedAt);
	if (!Number.isFinite(rotatedAtMs)) return false;
	return nowMs - rotatedAtMs <= BRIDGE_TOKEN_GRACE_MS;
}

/** Expire the previous token after its grace window. Idempotent. */
export function expirePreviousToken(set: BridgeTokenSet, nowMs: number): BridgeTokenSet {
	if (!previousTokenValid(set, nowMs)) return { active: set.active, previous: null, rotatedAt: null };
	return set;
}

/** Serialize a token set for the restricted token file (0600, outside the repo). */
export function serializeTokenSet(set: BridgeTokenSet): string {
	return JSON.stringify(set);
}

/** Parse a token set from the restricted token file. Corrupt input yields blank. */
export function parseTokenSet(raw: string): BridgeTokenSet {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyTokenSet();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyTokenSet();
	const record = parsed as Record<string, unknown>;
	if (typeof record.active !== "string") return emptyTokenSet();
	const previous = typeof record.previous === "string" ? record.previous : null;
	const rotatedAt = typeof record.rotatedAt === "string" ? record.rotatedAt : null;
	return { active: record.active, previous, rotatedAt };
}
