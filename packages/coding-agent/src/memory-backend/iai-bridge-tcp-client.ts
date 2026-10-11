/**
 * TCP client for the IAI long-term memory bridge.
 *
 * Speaks the v1 newline-delimited JSON envelope protocol
 * (`iai-bridge-protocol.ts`) over TCP — typically through an SSH local
 * forward to the bridge's loopback listener. Bearer authentication stays
 * enabled even over the tunnel.
 */
import * as net from "node:net";
import {
	buildBridgeEnvelope,
	parseBridgeEnvelope,
	type IaiBridgeArchiveBody,
	type IaiBridgeEnvelope,
	type IaiBridgeMessageKind,
} from "./iai-bridge-protocol";

export interface IaiBridgeTcpOptions {
	host: string;
	port: number;
	token: string;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

function readFrame(socket: net.Socket, timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Bridge response timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (buffer.length > MAX_FRAME_BYTES + 1024) {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error("Bridge response exceeded frame limit"));
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline >= 0) {
			clearTimeout(timer);
			resolve(buffer.slice(0, newline));
		}
	});
	socket.on("error", (error: Error) => {
		clearTimeout(timer);
		reject(error);
	});
	socket.on("close", () => {
		clearTimeout(timer);
		reject(new Error("Bridge connection closed before a full frame arrived"));
	});
	return promise;
}

/** Send one envelope and await its response frame. */
export async function bridgeRequest(
	options: IaiBridgeTcpOptions,
	kind: Extract<IaiBridgeMessageKind, "archive" | "recall" | "health">,
	body:
		| IaiBridgeArchiveBody
		| { query: string; bank: string; projectId: string; limit: number }
		| Record<string, never>,
	id: string,
): Promise<IaiBridgeEnvelope> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const envelope = buildBridgeEnvelope({ id, kind, auth: options.token, body });
	const socket = net.createConnection({ host: options.host, port: options.port });
	try {
		const frame = await new Promise<string>((resolve, reject) => {
			socket.on("connect", () => {
				socket.write(`${JSON.stringify(envelope)}\n`, "utf8");
			});
			readFrame(socket, timeoutMs).then(resolve, reject);
		});
		const parsed = parseBridgeEnvelope(frame.trim());
		if (!parsed.ok || !parsed.envelope) {
			throw new Error(`Bridge returned a malformed frame: ${parsed.error ?? "unknown"}`);
		}
		return parsed.envelope;
	} finally {
		socket.destroy();
	}
}

/** Read a bearer token from the restricted client credential file. */
export async function readBridgeTokenFile(path: string): Promise<string> {
	const file = Bun.file(path);
	const raw = await file.text();
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Bridge token file is corrupt.");
	}
	const active = (parsed as Record<string, unknown>).active;
	if (typeof active !== "string" || active.length === 0) {
		throw new Error("Bridge token file holds no active token.");
	}
	return active;
}
