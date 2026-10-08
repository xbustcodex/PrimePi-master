import type { HarnessModule, HarnessState, IsolatedPlugin, StageKind } from "../contract";

export interface IsolatedModuleOptions {
	readonly name: string;
	readonly stage: StageKind;
	/** Lower runs earlier within a stage. */
	readonly priority?: number;
	readonly isolated: IsolatedPlugin;
	/**
	 * Conservative in-process path: validated fallback used when the isolated
	 * runtime fails or when no backend is configured. MUST be dependency-free
	 * and deterministic (the harness contract for every in-process module).
	 */
	conservativeProcess(state: HarnessState): void;
	readonly validate?: (state: HarnessState) => string[];
}

/**
 * Build a harness module whose primary work runs isolated and whose
 * `process` is the validated conservative fallback. The pipeline owns the
 * isolation/fallback authority (see runTokenHarnessIsolated); the module only
 * supplies data transformation.
 */
export function createIsolatedModule(options: IsolatedModuleOptions): HarnessModule {
	return {
		name: options.name,
		stage: options.stage,
		priority: options.priority ?? 10,
		isolated: options.isolated,
		process(state) {
			options.conservativeProcess(state);
		},
		validate(state) {
			return options.validate?.(state) ?? [];
		},
		health() {
			return { status: "available" };
		},
	};
}
