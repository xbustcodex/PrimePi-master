/**
 * IAI MCP client wrapper for communicating with the IAI daemon.
 * Uses JSON-RPC over Unix domain sockets (or named pipes on Windows).
 */
import * as fs from "node:fs";
import * as net from "node:net";

// SOCKET_PATH from iai-mcp/concurrency.py - default location for IAI daemon socket
const SOCKET_PATH = (() => {
	if (typeof process !== "undefined" && process.platform === "win32") {
		return "\\\\.\\pipe\\iai-mcp-daemon";
	}
	return `${process.env.HOME || process.env.USERPROFILE}/.iai-mcp/.daemon.sock`;
})();
import type {
	IaiDaemonConfig,
	IaiMcpTool,
	IaiCaptureInput,
	IaiRecallOptions,
	IaiSearchOptions,
	IaiConsolidateOptions,
	IaiDaemonStatus,
	IaiBankConfig,
} from "./iai-types";

/** JSON-RPC request envelope */
interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/** JSON-RPC response envelope */
interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** IAI MCP client */
export interface IaiNormalizedHit {
	id: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize a `memory_recall` response (`{hits: [{record_id, literal_surface,
 * score, ...}]}`) into PrimePi result rows.
 */
export function normalizeRecallHits(response: unknown): IaiNormalizedHit[] {
	const record = asRecord(response);
	const hits = Array.isArray(record?.hits) ? record.hits : [];
	const out: IaiNormalizedHit[] = [];
	for (const hit of hits) {
		const node = asRecord(hit);
		if (!node) continue;
		const id = asString(node.record_id);
		if (!id) continue;
		out.push({
			id,
			content: asString(node.literal_surface) ?? "",
			score: asNumber(node.score),
			timestamp: asString(node.captured_at) ?? undefined,
		});
	}
	return out;
}

/**
 * Normalize a `memory_search` response (`{hits: [{record_id, surface,
 * tier, lane, score/cos}], frame}`) into PrimePi result rows.
 */
export function normalizeSearchHits(response: unknown): IaiNormalizedHit[] {
	const record = asRecord(response);
	const hits = Array.isArray(record?.hits) ? record.hits : [];
	const out: IaiNormalizedHit[] = [];
	for (const hit of hits) {
		const node = asRecord(hit);
		if (!node) continue;
		const id = asString(node.record_id);
		if (!id) continue;
		out.push({
			id,
			content: asString(node.surface) ?? "",
			score: asNumber(node.score) ?? asNumber(node.cos),
		});
	}
	return out;
}

export class IaiMcpClient {
	private socketPath: string;
	private connectTimeoutMs: number;
	private requestTimeoutMs: number;
	private pendingRequests = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private nextId = 1;

	constructor(config: IaiDaemonConfig = {}) {
		this.socketPath = config.socketPath ?? SOCKET_PATH.toString();
		this.connectTimeoutMs = config.connectTimeoutMs ?? 5000;
		this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
	}

	/**
	 * Connect to the IAI daemon and start listening for responses.
	 */
	async connect(): Promise<void> {
		// Connection is established per-request via the socket
		// We verify the socket exists
		if (!fs.existsSync(this.socketPath)) {
			throw new Error(`IAI daemon socket not found at ${this.socketPath}. Is the daemon running?`);
		}
	}

	/**
	 * Send a JSON-RPC request to the daemon.
	 */
	async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const { promise, resolve, reject } = Promise.withResolvers<T>();

		const timeout = setTimeout(() => {
			this.pendingRequests.delete(id);
			reject(new Error(`Request ${method} timed out after ${this.requestTimeoutMs}ms`));
		}, this.requestTimeoutMs);

		this.pendingRequests.set(id, {
			resolve: value => {
				clearTimeout(timeout);
				resolve(value as T);
			},
			reject: error => {
				clearTimeout(timeout);
				reject(error);
			},
		});

		this.sendRequest(request).catch(reject);
		return promise;
	}

	/**
	 * Send raw request to the Unix domain socket.
	 */
	private async sendRequest(request: JsonRpcRequest): Promise<void> {
		const data = JSON.stringify(request) + "\n";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		{
			const socket = net.createConnection(this.socketPath, () => {
				socket.write(data);
			});

			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const response: JsonRpcResponse = JSON.parse(line);
						const pending = this.pendingRequests.get(response.id);
						if (pending) {
							this.pendingRequests.delete(response.id);
							if (response.error) {
								pending.reject(new Error(`${response.error.message} (code ${response.error.code})`));
							} else {
								pending.resolve(response.result);
							}
						}
					} catch {
						// Ignore parse errors
					}
				}
			});

			socket.on("error", err => {
				const pending = this.pendingRequests.get(request.id);
				if (pending) {
					this.pendingRequests.delete(request.id);
					pending.reject(err);
				}
				reject(err);
			});

			socket.on("close", () => {
				// Clean up any pending requests
				for (const [, pending] of this.pendingRequests) {
					pending.reject(new Error("Socket closed unexpectedly"));
				}
				this.pendingRequests.clear();
				resolve();
			});
		}
		return promise;
	}

	/**
	 * Call a specific IAI MCP tool.
	 */
	async callTool<T>(tool: IaiMcpTool, args: Record<string, unknown>): Promise<T> {
		return this.request<T>(tool, args);
	}

	/**
	 * Recall memories from the IAI brain. The engine's wire contract takes
	 * `cue` (required) and answers with `{hits: [...]}`; both are normalized
	 * here so callers keep PrimePi naming.
	 */
	async recall(options: IaiRecallOptions): Promise<{
		results: Array<{
			id: string;
			content: string;
			source?: string;
			timestamp?: string;
			score?: number;
			importance?: number;
		}>;
	}> {
		const response = await this.callTool<unknown>("memory_recall", {
			cue: options.query,
			budget_tokens: options.budget,
		});
		return { results: normalizeRecallHits(response) };
	}

	/**
	 * Search memories using hybrid lexical + semantic search. The engine
	 * takes `{query, k}` and answers `{hits, frame}`; normalized here.
	 */
	async search(options: IaiSearchOptions): Promise<{
		results: Array<{ id: string; content: string; source?: string; timestamp?: string; score?: number }>;
	}> {
		const response = await this.callTool<unknown>("memory_search", {
			query: options.query,
			k: options.limit ?? 8,
		});
		return { results: normalizeSearchHits(response) };
	}

	/**
	 * Capture a memory turn. The engine requires `text`; `cue` defaults to
	 * the text itself server-side when omitted.
	 */
	async capture(input: IaiCaptureInput): Promise<{ id: string; stored: boolean }> {
		const response = await this.callTool<{ record_id?: unknown; status?: unknown }>("memory_capture", {
			text: input.content,
			cue: input.content.slice(0, 500),
			session_id: input.sessionId,
			extra_tags: input.tags,
		});
		const id = typeof response?.record_id === "string" ? response.record_id : "";
		return { id, stored: id.length > 0 };
	}

	/**
	 * Consolidate memories.
	 */
	async consolidate(options: IaiConsolidateOptions = {}): Promise<{ success: boolean }> {
		return this.callTool("memory_consolidate", {
			full: options.full,
			extract: options.extract,
			sleep: options.sleep,
			retain: options.retain,
		});
	}

	/**
	 * Get daemon status.
	 */
	async getStatus(): Promise<IaiDaemonStatus> {
		const result = await this.callTool("status_light", {});
		return result as IaiDaemonStatus;
	}

	/**
	 * Get brain topology.
	 */
	async getTopology(): Promise<unknown> {
		return this.callTool("topology", {});
	}

	/**
	 * Get recent episodes.
	 */
	async getEpisodes(limit = 10): Promise<{ episodes: Array<{ id: string; content: string; timestamp: string }> }> {
		return this.callTool("episodes_recent", { limit });
	}

	/**
	 * Structural recall via TEM.
	 */
	async structuralRecall(
		query: string,
		role?: string,
	): Promise<{ results: Array<{ role: string; filler: string; score: number }> }> {
		return this.callTool("memory_recall_structural", { query, role });
	}

	/**
	 * Temporal recall.
	 */
	async temporalRecall(
		query: string,
		start?: string,
		end?: string,
	): Promise<{ events: Array<{ id: string; content: string; timestamp: string }> }> {
		return this.callTool("memory_temporal_recall", { query, start, end });
	}

	/**
	 * Reinforce memories.
	 */
	async reinforce(ids: string[]): Promise<{ reinforced: number }> {
		return this.callTool("memory_reinforce", { ids });
	}

	/**
	 * Detect contradictions.
	 */
	async contradict(
		cue: string,
		cueEmbedding?: number[],
	): Promise<{ contradictions: Array<{ id: string; content: string; score: number }> }> {
		return this.callTool("memory_contradict", { cue, cue_embedding: cueEmbedding });
	}

	/**
	 * Profile get/set.
	 */
	async profileGet(knob?: string): Promise<Record<string, unknown>> {
		return this.callTool("profile_get_set", { knob });
	}

	async profileSet(knob: string, value: unknown): Promise<{ success: boolean }> {
		return this.callTool("profile_get_set", { knob, value });
	}

	/**
	 * Close any open connections.
	 */
	async close(): Promise<void> {
		// No persistent connection to close
		this.pendingRequests.clear();
	}
}

/**
 * Singleton client instance for reuse.
 */
let globalClient: IaiMcpClient | null = null;

export function getIaiClient(config?: IaiDaemonConfig): IaiMcpClient {
	if (!globalClient) {
		globalClient = new IaiMcpClient(config);
	}
	return globalClient;
}

export function resetIaiClient(): void {
	if (globalClient) {
		globalClient.close();
		globalClient = null;
	}
}

export type {
	IaiDaemonConfig,
	IaiMcpTool,
	IaiCaptureInput,
	IaiRecallOptions,
	IaiSearchOptions,
	IaiConsolidateOptions,
	IaiDaemonStatus,
	IaiBankConfig,
} from "./iai-types";
