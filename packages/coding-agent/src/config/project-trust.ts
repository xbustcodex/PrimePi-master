/**
 * Project trust resolution for OMP.
 *
 * Determines whether a project is trusted. In the SDK, this uses the default
 * project trust setting when no explicit trust decision exists. The CLI can
 * provide a full ProjectTrustContext with UI for interactive prompting.
 */
import type { LoadExtensionsResult } from "../extensibility/extensions";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustDecision,
	type ProjectTrustUpdate,
} from "./trust-manager";
import { ProjectTrustStore } from "./trust-manager";
export { ProjectTrustStore };
export type { ProjectTrustDecision, ProjectTrustUpdate, ProjectTrustOption } from "./trust-manager";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export type DefaultProjectTrust = "ask" | "always" | "never";

/** Minimal UI context for trust prompting. */
export interface ProjectTrustUIContext {
	select(title: string, options: string[]): Promise<string | undefined>;
}

/** Context for project trust resolution. */
export interface ProjectTrustContext {
	hasUI: boolean;
	ui: ProjectTrustUIContext;
}

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext?: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

const APP_NAME = "OMP";

function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map(option => option.label),
	);
	return options.find(option => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	// If no UI context provided (e.g., SDK usage), fall back to default behavior:
	// "ask" -> not trusted (safe default). CLI can re-prompt and re-initialize.
	if (!options.projectTrustContext?.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext!);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}

/**
 * Emits a project_trust event to all loaded extensions.
 * Extensions can respond with { trusted: "yes"|"no", remember: boolean } to auto-decide.
 * Note: In OMP, extension event emission happens via the runner after initialization.
 * This is a placeholder for future integration.
 */
async function emitProjectTrustEvent(
	_extensionsResult: LoadExtensionsResult,
	_event: { type: "project_trust"; cwd: string },
	_ctx: ProjectTrustContext | undefined,
): Promise<{
	result: { trusted: "yes" | "no"; remember: boolean } | null;
	errors: Array<{ extensionPath: string; error: string }>;
}> {
	// TODO: Implement extension event emission via runner after initialization.
	// For now, return no result so the CLI handles the trust prompt.
	return { result: null, errors: [] };
}
