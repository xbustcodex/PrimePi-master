/**
 * IAI long-term memory bridge protocol (v1).
 *
 * JSON envelopes over a TCP stream, newline-delimited (same framing as the
 * local IAI daemon socket). Authentication is a bearer token compared in
 * constant time; a missing or mismatched token yields an error envelope and
 * no further processing.
 *
 * This module is transport-free: it only builds, parses, and validates
 * envelopes. The socket layer lives elsewhere so the protocol and its guards
 * stay unit-testable without network access.
 */
import { timingSafeEqual } from "node:crypto";

export const IAI_BRIDGE_PROTOCOL_VERSION = 1;

export type IaiBridgeMessageKind =
	| "archive"
	| "archive-ack"
	| "recall"
	| "recall-result"
	| "health"
	| "health-result"
	| "error";

export interface IaiBridgeArchiveBody {
	key: string;
	bank: string;
	projectId: string;
	sessionId: string;
	contentHash: string;
	bytes: number;
	idempotencyKey: string;
	version: number;
}

export interface IaiBridgeArchiveAckBody {
	key: string;
	idempotencyKey: string;
	durable: boolean;
	storedAt: string;
}

export interface IaiBridgeRecallBody {
	query: string;
	bank: string;
	projectId: string;
	limit: number;
}

export interface IaiBridgeRecallItem {
	key: string;
	snippet: string;
	score: number;
}

export interface IaiBridgeRecallResultBody {
	items: IaiBridgeRecallItem[];
	truncated: boolean;
}

export interface IaiBridgeHealthResultBody {
	ok: boolean;
	version: number;
	pendingWrites: number;
}

export interface IaiBridgeErrorBody {
	code: string;
	message: string;
}

export interface IaiBridgeEnvelope {
	v: number;
	id: string;
	kind: IaiBridgeMessageKind;
	auth: string;
	body: unknown;
}

const MESSAGE_KINDS: ReadonlySet<string> = new Set([
	"archive",
	"archive-ack",
	"recall",
	"recall-result",
	"health",
	"health-result",
	"error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Constant-time bearer token comparison. */
export function verifyBridgeToken(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Build a protocol envelope. */
export function buildBridgeEnvelope(input: {
	id: string;
	kind: IaiBridgeMessageKind;
	auth: string;
	body: unknown;
}): IaiBridgeEnvelope {
	return { v: IAI_BRIDGE_PROTOCOL_VERSION, id: input.id, kind: input.kind, auth: input.auth, body: input.body };
}

/** Serialize an envelope to a single newline-terminated frame. */
export function serializeBridgeEnvelope(envelope: IaiBridgeEnvelope): string {
	return `${JSON.stringify(envelope)}\n`;
}

export interface BridgeParseResult {
	ok: boolean;
	envelope?: IaiBridgeEnvelope;
	error?: string;
}

/** Parse and structurally validate one frame. Authentication is NOT checked here. */
export function parseBridgeEnvelope(frame: string): BridgeParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame);
	} catch {
		return { ok: false, error: "invalid-json" };
	}
	if (!isRecord(parsed)) return { ok: false, error: "invalid-envelope" };
	if (parsed.v !== IAI_BRIDGE_PROTOCOL_VERSION) return { ok: false, error: "unsupported-version" };
	if (typeof parsed.id !== "string" || parsed.id.length === 0) return { ok: false, error: "invalid-id" };
	if (typeof parsed.kind !== "string" || !MESSAGE_KINDS.has(parsed.kind)) {
		return { ok: false, error: "invalid-kind" };
	}
	if (typeof parsed.auth !== "string") return { ok: false, error: "invalid-auth" };
	if (!isRecord(parsed.body) && parsed.body !== null) return { ok: false, error: "invalid-body" };
	return {
		ok: true,
		envelope: {
			v: parsed.v as number,
			id: parsed.id,
			kind: parsed.kind as IaiBridgeMessageKind,
			auth: parsed.auth,
			body: parsed.body,
		},
	};
}

/** Validate an archive body. */
export function validateArchiveBody(body: unknown): body is IaiBridgeArchiveBody {
	if (!isRecord(body)) return false;
	return (
		typeof body.key === "string" &&
		body.key.length > 0 &&
		typeof body.bank === "string" &&
		body.bank.length > 0 &&
		typeof body.projectId === "string" &&
		body.projectId.length > 0 &&
		typeof body.sessionId === "string" &&
		typeof body.contentHash === "string" &&
		body.contentHash.length > 0 &&
		typeof body.bytes === "number" &&
		Number.isFinite(body.bytes) &&
		body.bytes >= 0 &&
		typeof body.idempotencyKey === "string" &&
		body.idempotencyKey.length > 0 &&
		typeof body.version === "number" &&
		Number.isInteger(body.version) &&
		body.version >= 0
	);
}

/** Validate a recall body (bounded limit). */
export function validateRecallBody(body: unknown): body is IaiBridgeRecallBody {
	if (!isRecord(body)) return false;
	return (
		typeof body.query === "string" &&
		body.query.length > 0 &&
		body.query.length <= 2000 &&
		typeof body.bank === "string" &&
		body.bank.length > 0 &&
		typeof body.projectId === "string" &&
		body.projectId.length > 0 &&
		typeof body.limit === "number" &&
		Number.isInteger(body.limit) &&
		body.limit >= 1 &&
		body.limit <= 50
	);
}

/** Build an authenticated error envelope. */
export function bridgeError(id: string, code: string, message: string): IaiBridgeEnvelope {
	const body: IaiBridgeErrorBody = { code, message };
	return buildBridgeEnvelope({ id, kind: "error", auth: "", body });
}
