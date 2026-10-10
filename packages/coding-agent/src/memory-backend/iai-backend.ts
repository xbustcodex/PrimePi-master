/**
 * IAI Personal Memory Engine backend adapter for PrimePi.
 * Implements the MemoryBackend interface using the IAI daemon via MCP.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { Settings } from "../config/settings";
import type { ModelRegistry } from "../config/model-registry";
import type {
	MemoryBackend,
	MemoryBackendId,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
	MemoryBackendSearchItem,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendOperationContext,
	MemoryPromptPreparation,
} from "./types";
import type { AgentSessionEvent } from "../session/agent-session-events";
import {
	IaiMcpClient,
	getIaiClient,
	resetIaiClient,
	type IaiDaemonConfig,
	type IaiBankConfig,
	type IaiRecallOptions,
	type IaiSearchOptions,
	type IaiCaptureInput,
	type IaiDaemonStatus,
} from "./iai-client";
import { loadIaiConfig, type IaiBackendConfig } from "./iai-config";

const DEFAULT_RECALL_BUDGET = 4000;
const DEFAULT_RECALL_MAX_TOKENS = 2000;
const DEFAULT_RECALL_CONTEXT_TURNS = 3;
const DEFAULT_RECALL_MAX_QUERY_CHARS = 2000;

function formatMemoriesBlock(memories: Array<{ content: string; source?: string; timestamp?: string }>): string {
	if (memories.length === 0) return "";
	const lines = memories.map((m, i) => {
		const source = m.source ? ` [${m.source}]` : "";
		const date = m.timestamp ? ` (${m.timestamp.slice(0, 10)})` : "";
		return `${i + 1}. ${m.content}${source}${date}`;
	});
	return `<memories>\nRelevant IAI memories:\n\n${lines.join("\n\n")}\n</memories>`;
}

function formatSearchResults(
	results: Array<{ id: string; content: string; source?: string; timestamp?: string; score?: number }>,
): MemoryBackendSearchItem[] {
	return results.map(r => ({
		id: r.id,
		content: r.content,
		source: r.source,
		timestamp: r.timestamp,
		score: r.score,
	}));
}

/** IAI memory backend implementation */
export class IaiMemoryBackend implements MemoryBackend {
	readonly id: MemoryBackendId = "iai";

	private client: IaiMcpClient | null = null;
	private config: Partial<IaiBackendConfig> = {};
	private bankConfig: IaiBankConfig = { bank: "", recallBanks: [] };
	private sessionId: string = "";
	private session: AgentSession | null = null;
	private settings: Settings | null = null;
	private modelRegistry: ModelRegistry | null = null;
	private agentDir: string = "";
	private cwd: string = "";
	private taskDepth: number = 0;
	private hasRecalledForFirstTurn = false;
	private lastRecallSnippet?: string;

	async start(options: MemoryBackendStartOptions): Promise<void> {
		this.session = options.session;
		this.settings = options.settings;
		this.modelRegistry = options.modelRegistry;
		this.agentDir = options.agentDir;
		this.cwd = options.session.sessionManager?.getCwd() ?? options.agentDir;
		this.taskDepth = options.taskDepth;
		this.sessionId = options.session.sessionId ?? `session-${Date.now()}`;

		// Load IAI backend configuration from settings
		this.loadConfig();

		// Initialize IAI client
		const daemonConfig: IaiDaemonConfig = {
			connectTimeoutMs: 5000,
			requestTimeoutMs: 30000,
		};
		this.client = getIaiClient(daemonConfig);

		try {
			await this.client.connect();
			logger.debug("IAI backend: connected to daemon", { sessionId: this.sessionId });
		} catch (error) {
			logger.warn("IAI backend: daemon not available, running in degraded mode", { error: String(error) });
		}

		// Set up session listeners
		this.attachSessionListeners();

		// Promote eligible working memory on startup (like Mnemopi)
		this.promoteEligibleWorkingMemory();
	}

	private loadConfig(): void {
		if (!this.settings) return;

		this.config = loadIaiConfig(this.settings);

		// Resolve bank configuration
		this.bankConfig = this.resolveBankConfig();
	}

	private resolveBankConfig(): { bank: string; recallBanks: string[]; globalBank?: string } {
		const scoping = this.config.scoping ?? "per-project";
		const projectId = this.getProjectId();

		let bank = this.config.bank ?? this.sessionId;
		const baseBank = this.config.baseBank ?? "shared";
		let globalBank = this.config.globalBank ?? baseBank;

		if (scoping === "per-project-tagged") {
			bank = `project-${projectId}`;
			globalBank = "global";
		}

		const recallBanks = this.config.recallBanks ?? [bank];
		const globalBankConfigured = this.config.globalBank;
		if (globalBankConfigured && !recallBanks.includes(globalBank)) {
			recallBanks.push(globalBank);
		}

		return { bank, recallBanks: Array.from(new Set(recallBanks)), globalBank };
	}

	private getProjectId(): string {
		// Use cwd as project identifier
		const projectDir = this.cwd.split(/[\\/]/).pop() ?? "default";
		return projectDir.replace(/[^a-zA-Z0-9_-]/g, "-");
	}

	/** Attach session event listeners for auto-recall and auto-retain */
	private attachSessionListeners(): void {
		if (!this.session) return;

		this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_start") {
				void this.maybeRecallOnAgentStart().catch(error => {
					logger.warn("IAI: auto-recall failed", { error: String(error) });
				});
			} else if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd(event.messages).catch(error => {
					logger.warn("IAI: auto-retain failed", { error: String(error) });
				});
			}
		});
	}

	/** Promote eligible working memory to episodic on startup */
	promoteEligibleWorkingMemory(): void {
		// IAI handles this via sleep/consolidation
		// Trigger a light consolidation on startup
		const client = this.client;
		if (client) {
			client.consolidate({ full: false, extract: false, sleep: true, retain: false }).catch(error => {
				logger.debug("IAI: startup consolidation skipped", { error: String(error) });
			});
		}
	}

	/** Build developer instructions for system prompt */
	async buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		const parts: string[] = [];

		parts.push("## IAI Long-Term Memory");
		parts.push("");
		parts.push("This agent has access to the IAI Personal Memory Engine for long-term memory storage and retrieval.");
		parts.push("");
		parts.push("**Available memory tools:**");
		parts.push("- `memory_recall` - Semantic recall of relevant memories");
		parts.push("- `memory_search` - Hybrid lexical + semantic search");
		parts.push("- `memory_recall_structural` - Structural/role-filler recall");
		parts.push("- `memory_temporal_recall` - Time-based event recall");
		parts.push("- `memory_capture` - Capture important information");
		parts.push("- `memory_reinforce` - Reinforce important memories");
		parts.push("- `memory_contradict` - Detect contradictions");
		parts.push("");
		parts.push("Memories are automatically recalled at session start and retained at session end.");
		parts.push("Use explicit tools when you need specific historical knowledge.");

		return parts.join("\n");
	}

	/** Clear all persisted state */
	async clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void> {
		if (!this.client) return;
		try {
			// IAI doesn't have a direct "clear all" - would need to delete banks
			logger.warn("IAI: clear not fully implemented - banks persist", { bank: this.bankConfig.bank });
		} catch (error) {
			logger.warn("IAI: clear failed", { error: String(error) });
		}
	}

	/** Force consolidation/retain now */
	async enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void> {
		await this.consolidate({ full: true, extract: true, sleep: true, retain: true });
	}

	/** Get backend status */
	async status(context: { agentDir: string; cwd: string; session?: AgentSession }): Promise<MemoryBackendStatus> {
		const daemonStatus = await this.getDaemonStatus();
		return {
			backend: "iai",
			active: daemonStatus.active,
			writable: true,
			searchable: true,
			scope: this.bankConfig.bank,
			workingCount: daemonStatus.workingCount,
			episodicCount: daemonStatus.episodicCount,
			tripleCount: daemonStatus.tripleCount,
			lastMemory: daemonStatus.lastMemory,
			lastRecall: daemonStatus.lastRecall,
			database: this.bankConfig.bank,
			message: daemonStatus.message,
			error: daemonStatus.error,
		};
	}

	/** Search memories */
	async search(
		context: { agentDir: string; cwd: string; session?: AgentSession },
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult> {
		if (!this.client) {
			return { backend: "iai", query, count: 0, items: [] };
		}

		try {
			const result = await this.client.search({
				query,
				limit: options?.limit,
				signal: options?.signal,
			});
			return {
				backend: "iai",
				query,
				count: result.results.length,
				items: formatSearchResults(result.results),
			};
		} catch (error) {
			logger.warn("IAI search failed", { error: String(error) });
			return { backend: "iai", query, count: 0, items: [], message: String(error) };
		}
	}

	/** Save a memory */
	async save(
		context: { agentDir: string; cwd: string; session?: AgentSession },
		input: string | { content: string; context?: string; source?: string; importance?: number },
	): Promise<MemoryBackendSaveResult> {
		if (!this.client) {
			return { backend: "iai", stored: 0, message: "Client not available" };
		}

		const saveInput = typeof input === "string" ? { content: input } : input;

		try {
			const result = await this.client.capture({
				content: saveInput.content,
				context: saveInput.context,
				source: saveInput.source ?? "user-save",
				importance: saveInput.importance ?? 0.5,
				sessionId: this.sessionId,
			});

			return {
				backend: "iai",
				stored: result.stored ? 1 : 0,
				ids: result.id ? [result.id] : undefined,
			};
		} catch (error) {
			logger.warn("IAI save failed", { error: String(error) });
			return { backend: "iai", stored: 0, message: String(error) };
		}
	}

	/** Render stats as markdown */
	async stats(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined> {
		const status = await this.status({ agentDir, cwd, session });
		const lines = [
			"# IAI Memory Statistics",
			"",
			`**Backend:** ${status.backend}`,
			`**Active:** ${status.active ? "Yes" : "No"}`,
			`**Bank:** ${status.scope ?? "N/A"}`,
			`**Working Memories:** ${status.workingCount ?? "N/A"}`,
			`**Episodic Memories:** ${status.episodicCount ?? "N/A"}`,
			`**Triples:** ${status.tripleCount ?? "N/A"}`,
			`**Last Memory:** ${status.lastMemory ?? "N/A"}`,
			`**Last Recall:** ${status.lastRecall ? "Yes" : "No"}`,
		];
		return lines.join("\n");
	}

	/** Diagnostics */
	async diagnose(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined> {
		const status = await this.getDaemonStatus();
		const lines = [
			"# IAI Diagnostics",
			"",
			`**Daemon Active:** ${status.active ? "Yes" : "No"}`,
			`**Bank:** ${this.bankConfig.bank}`,
			`**Recall Banks:** ${this.bankConfig.recallBanks.join(", ")}`,
			`**Global Bank:** ${this.bankConfig.globalBank ?? "N/A"}`,
			`**Working Count:** ${status.workingCount ?? "N/A"}`,
			`**Episodic Count:** ${status.episodicCount ?? "N/A"}`,
			`**Triples:** ${status.tripleCount ?? "N/A"}`,
			`**Database:** ${this.bankConfig.bank}`,
		];
		if (status.error) lines.push(`**Error:** ${status.error}`);
		return lines.join("\n");
	}

	/** Queue preview */
	async queuePreview(context: { agentDir: string; cwd: string; session?: AgentSession }): Promise<string | undefined> {
		return "IAI queue preview not yet implemented.";
	}

	/** Before agent start prompt - auto-recall */
	async beforeAgentStartPrompt(
		session: AgentSession,
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (!this.client) return undefined;

		// Get config from session settings
		const autoRecall = this.config.autoRecall ?? true;
		if (!autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;

		const generation = ++this.recallGeneration;

		// Build query from recent conversation
		const history = this.extractMessages(session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = this.composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns ?? 3);
		const truncated = this.truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars ?? 2000);

		const { context, ok } = await this.recallForContext({ query: truncated, signal });
		if (!ok) return undefined;

		return {
			context: context ?? undefined,
			commit: () => {
				if (this.recallGeneration !== generation) return false;
				this.hasRecalledForFirstTurn = true;
				if (context) this.lastRecallSnippet = context;
				return true;
			},
		};
	}

	private recallGeneration = 0;

	/** Pre-compaction context hook */
	async preCompactionContext(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		if (!this.client) return undefined;

		const flat = this.extractMessages(session?.sessionManager ?? this.session?.sessionManager);
		const lastUser = flat.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = this.composeRecallQuery(lastUser.content, flat, this.config.recallContextTurns ?? 3);
		const truncated = this.truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars ?? 2000);

		const { context } = await this.recallForContext({ query: truncated });
		return context;
	}

	/** Apply settings changes */
	async applySettings(session: AgentSession, changed: readonly string[]): Promise<void> {
		// Reload config if IAI settings changed
		const iaiSettings = changed.filter(s => s.startsWith("iai."));
		if (iaiSettings.length > 0) {
			this.loadConfig();
			this.bankConfig = this.resolveBankConfig();
		}
	}

	// ========== Internal Implementation ==========

	private async getDaemonStatus(): Promise<IaiDaemonStatus> {
		if (!this.client) {
			return { backend: "iai", active: false, writable: false, searchable: false, error: "Client not initialized" };
		}
		try {
			return await this.client.getStatus();
		} catch (error) {
			return { backend: "iai", active: false, writable: false, searchable: false, error: String(error) };
		}
	}

	private async recallForContext(options: {
		query: string;
		signal?: AbortSignal;
	}): Promise<{ context: string | undefined; ok: boolean }> {
		if (!this.client) return { context: undefined, ok: false };

		try {
			const result = await this.client.recall({
				query: options.query,
				budget: this.config.recallBudget ?? DEFAULT_RECALL_BUDGET,
				maxTokens: this.config.recallMaxTokens ?? DEFAULT_RECALL_MAX_TOKENS,
				types: [],
				tags: [],
				tagsMatch: "any",
				signal: options.signal,
			});

			if (options.signal?.aborted) return { context: undefined, ok: false };

			const results = result.results ?? [];
			if (results.length === 0) return { context: undefined, ok: true };

			const formatted = formatMemoriesBlock(results);
			return { context: formatted, ok: true };
		} catch (error) {
			logger.debug("IAI recall failed", { error: String(error) });
			return { context: undefined, ok: false };
		}
	}

	/** Auto-recall on agent start */
	private async maybeRecallOnAgentStart(): Promise<void> {
		if (!this.client) return;
		if (!this.config.autoRecall) return;
		if (this.hasRecalledForFirstTurn) return;

		const generation = ++this.recallGeneration;
		const messages = this.extractMessages(this.session?.sessionManager);
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return;

		const query = this.composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns ?? 3);
		const truncated = this.truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars ?? 2000);

		let context: string | undefined;
		try {
			const { context: ctx } = await this.recallForContext({ query: truncated });
			context = ctx ?? undefined;
		} catch (error) {
			logger.warn("IAI: auto-recall failed", { error: String(error) });
			return;
		}

		if (this.recallGeneration !== generation) return;
		this.hasRecalledForFirstTurn = true;
		if (!context) return;
		this.lastRecallSnippet = context;

		try {
			await this.session?.refreshBaseSystemPrompt();
		} catch (error) {
			if (this.config.debug) logger.debug("IAI: prompt refresh after recall failed", { error: String(error) });
		}
	}

	/** Auto-retain on agent end */
	private async maybeRetainOnAgentEnd(messages: AgentMessage[]): Promise<void> {
		if (!this.client) return;
		if (!this.config.autoRetain) return;

		const flat = this.extractMessages(this.session?.sessionManager);
		const userTurns = flat.filter(m => m.role === "user").length;
		if (userTurns - (this.lastRetainedTurn ?? 0) < (this.config.retainEveryNTurns ?? 5)) return;

		try {
			await this.retainMessages(flat.slice(this.lastRetainedTurn ?? 0), `${this.sessionId}-${Date.now()}`);
			this.lastRetainedTurn = userTurns;
		} catch (error) {
			logger.warn("IAI: auto-retain failed", { error: String(error) });
		}
	}

	private lastRetainedTurn = 0;

	async forceRetainCurrentSession(): Promise<void> {
		const flat = this.extractMessages(this.session?.sessionManager);
		await this.retainMessages(flat, this.sessionId);
	}

	private async retainMessages(messages: Array<{ role: string; content: string }>, sourceId: string): Promise<void> {
		const { transcript } = this.prepareRetentionTranscript(messages, true);
		if (!transcript) return;

		await this.client?.capture({
			content: transcript,
			context: this.config.retainContext,
			source: "coding-agent-transcript",
			importance: 0.65,
			sessionId: this.sessionId,
			tags: ["coding-agent", "transcript"],
			metadata: {
				session_id: this.sessionId,
				source_id: sourceId,
				message_count: messages.length,
				cwd: this.cwd,
			},
		});
	}

	// ========== Helper Methods ==========

	private extractMessages(
		sessionManager?: AgentSession["sessionManager"],
	): Array<{ role: "user" | "assistant"; content: string }> {
		if (!sessionManager) return [];
		// This would need to be implemented based on the actual sessionManager API
		// For now, return empty array
		return [];
	}

	private composeRecallQuery(
		latestPrompt: string,
		history: Array<{ role: string; content: string }>,
		contextTurns: number,
	): string {
		// Simplified - would use the actual composeRecallQuery from hindsight/content
		const recent = history.slice(-contextTurns * 2);
		const context = recent.map(m => `[${m.role}] ${m.content}`).join("\n");
		return `${context}\n\nCurrent: ${latestPrompt}`;
	}

	private truncateRecallQuery(query: string, latestPrompt: string, maxChars: number): string {
		if (query.length <= maxChars) return query;
		// Keep the latest prompt, truncate history
		const promptLen = latestPrompt.length + 10;
		if (promptLen >= maxChars) return latestPrompt.slice(0, maxChars);
		return "..." + query.slice(-(maxChars - promptLen));
	}

	private prepareRetentionTranscript(
		messages: Array<{ role: string; content: string }>,
		includeTimestamps: boolean,
	): { transcript: string; messageCount: number } {
		const lines = messages.map(m => `[role: ${m.role}] ${m.content}`);
		return { transcript: lines.join("\n\n"), messageCount: messages.length };
	}

	// ========== Memory Operations ==========

	/** Explicit save for user-facing memory capture */
	async rememberInScope(input: {
		content: string;
		context?: string;
		source?: string;
		importance?: number;
	}): Promise<string | undefined> {
		if (!this.client) return undefined;
		try {
			const result = await this.client.capture({
				content: input.content,
				context: input.context,
				source: input.source,
				importance: input.importance ?? 0.5,
				sessionId: this.sessionId,
			});
			return result.id;
		} catch (error) {
			logger.warn("IAI remember failed", { error: String(error) });
			return undefined;
		}
	}

	/** Explicit search for user-facing search */
	async searchScoped(query: string, signal?: AbortSignal): Promise<MemoryBackendSearchResult> {
		return this.search({ agentDir: this.agentDir, cwd: this.cwd }, query, { limit: 10, signal });
	}

	/** Full consolidation */
	async consolidate(
		options: { full?: boolean; extract?: boolean; sleep?: boolean; retain?: boolean } = {},
	): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.consolidate({
				full: options.full,
				extract: options.extract,
				sleep: options.sleep,
				retain: options.retain,
			});
		} catch (error) {
			logger.warn("IAI consolidate failed", { error: String(error) });
		}
	}

	async dispose(): Promise<void> {
		this.client?.close();
		resetIaiClient();
		this.client = null;
	}
}

/** Register the IAI backend */
export function registerIaiBackend(): void {
	// Registration happens in resolve.ts
}
