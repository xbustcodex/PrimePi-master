/**
 * IAI-specific types for the IAI memory backend integration.
 */

/** IAI MCP tool names */
export const IAI_MCP_TOOLS = [
	"memory_recall",
	"memory_search",
	"memory_recall_structural",
	"memory_reinforce",
	"memory_contradict",
	"memory_capture",
	"memory_consolidate",
	"memory_temporal_recall",
	"profile_get_set",
	"topology",
	"schema_list",
	"events_query",
	"episodes_recent",
	"curiosity_pending",
	"status_light",
] as const;

export type IaiMcpTool = (typeof IAI_MCP_TOOLS)[number];

/** IAI memory bank configuration */
export interface IaiBankConfig {
	/** Bank name for this project/session */
	bank: string;
	/** Optional shared/global bank for cross-project recall */
	globalBank?: string;
	/** Recall banks (includes retain + global) */
	recallBanks: string[];
}

/** IAI daemon connection configuration */
export interface IaiDaemonConfig {
	/** Socket path (auto-detected if not specified) */
	socketPath?: string;
	/** Connection timeout in ms */
	connectTimeoutMs?: number;
	/** Request timeout in ms */
	requestTimeoutMs?: number;
}

/** IAI memory capture input */
export interface IaiCaptureInput {
	/** Content to capture */
	content: string;
	/** Optional context */
	context?: string;
	/** Source identifier */
	source?: string;
	/** Importance weight (0-1) */
	importance?: number;
	/** Session ID */
	sessionId?: string;
	/** Tags for filtering */
	tags?: string[];
	/** Metadata */
	metadata?: Record<string, unknown>;
}

/** IAI memory recall options */
export interface IaiRecallOptions {
	/** Query text */
	query: string;
	/** Bank to search */
	bank?: string;
	/** Token budget */
	budget?: number;
	/** Max tokens in response */
	maxTokens?: number;
	/** Recall types */
	types?: string[];
	/** Tag filters */
	tags?: string[];
	/** Tag matching mode */
	tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	/** Abort signal */
	signal?: AbortSignal;
}

/** IAI search options */
export interface IaiSearchOptions {
	/** Search query */
	query: string;
	/** Bank to search */
	bank?: string;
	/** Limit */
	limit?: number;
	/** Abort signal */
	signal?: AbortSignal;
}

/** IAI consolidation options */
export interface IaiConsolidateOptions {
	/** Full cross-session consolidation */
	full?: boolean;
	/** Extract facts */
	extract?: boolean;
	/** Run sleep/consolidation */
	sleep?: boolean;
	/** Retain transcript */
	retain?: boolean;
}

/** IAI daemon status */
export interface IaiDaemonStatus {
	backend: "iai";
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	bank?: string;
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}
