import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	hasCredentialFreeModels,
	isCredentialFree,
	withFreeFlag,
	type ModelAccess,
} from "@oh-my-pi/pi-catalog/model-access";
import type { Model } from "@oh-my-pi/pi-ai/types";

/**
 * Regression cover for the credential-free pipeline repair.
 *
 * The retired bare `opencode` provider id (split into `opencode-zen` /
 * `opencode-go`) used to drive an `ANONYMOUS_FREE_MODELS` set keyed
 * `opencode:space-bunny-free`. Because no model row can carry provider
 * `opencode`, that mapping never matched a real model, and a live
 * credential-less probe of the Zen gateway now answers `403 FreeTierError`
 * ("OpenCode's free tier can only be used from within OpenCode"). Anonymous
 * access is therefore rule-owned, never inferred.
 */

function bundledModel(provider: string, id: string): Model<"openai-completions"> {
	const raw = getBundledModels(provider as "opencode-zen").find(model => model.id === id);
	if (!raw) throw new Error(`missing bundled row ${provider}/${id}`);
	return buildModel(raw) as Model<"openai-completions">;
}

describe("free-tier classification stays suffix-driven", () => {
	test("OpenCode Zen and Go free rows are free without any rule", () => {
		for (const provider of ["opencode-zen", "opencode-go"]) {
			const model = bundledModel(provider, "space-bunny-free");
			expect(model.free).toBe(true);
		}
	});

	test("a -free suffix alone never grants credential-free access", () => {
		// The defect this repair fixes: free and credential-free are independent.
		for (const id of ["space-bunny-free", "muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free"]) {
			const model = bundledModel("opencode-zen", id);
			expect(model.free).toBe(true);
			expect(isCredentialFree(model)).toBe(false);
		}
	});

	test("OpenRouter :free rows are free but still require an API key", () => {
		for (const id of ["openrouter/free", "deepseek/deepseek-v4-flash:free"]) {
			const model = bundledModel("openrouter", id);
			expect(model.free).toBe(true);
			expect(isCredentialFree(model)).toBe(false);
		}
	});

	test("paid rows are not free and not credential-free", () => {
		const model = bundledModel("opencode-zen", "muse-spark-1.2");
		expect(model.free).toBeUndefined();
		expect(isCredentialFree(model)).toBe(false);
	});

	test("withFreeFlag derives only from the id suffix", () => {
		expect(withFreeFlag({ id: "x:free" }).free).toBe(true);
		expect(withFreeFlag({ id: "x-free" }).free).toBe(true);
		expect(withFreeFlag({ id: "openrouter/free" }).free).toBe(true);
		expect(withFreeFlag({ id: "x-contributor" }).free).toBeUndefined();
		expect(withFreeFlag({ id: "x" }).free).toBeUndefined();
	});
});

describe("no OpenCode route is anonymously reachable", () => {
	test("neither Zen nor Go marks any bundled model credential-free", () => {
		for (const provider of ["opencode-zen", "opencode-go"]) {
			const models = getBundledModels(provider as "opencode-zen").map(
				row => buildModel(row) as Model<"openai-completions">,
			);
			expect(models.some(isCredentialFree)).toBe(false);
			expect(hasCredentialFreeModels(models)).toBe(false);
		}
	});

	test("the retired bare opencode provider cannot resurrect the old mapping", () => {
		// Guards the exact regression: the stale key was `opencode:space-bunny-free`.
		// A free row carrying the retired `opencode` provider id stays unclassified.
		const retiredOpenCodeRow: { provider: string; id: string; free?: true; access?: ModelAccess } = {
			provider: "opencode",
			id: "space-bunny-free",
			free: true,
		};
		expect(isCredentialFree(retiredOpenCodeRow)).toBe(false);
	});
});

describe("credential-free is driven by the explicit access axis", () => {
	test("anonymous and local are the only credential-free access values", () => {
		expect(isCredentialFree({ access: "anonymous" })).toBe(true);
		expect(isCredentialFree({ access: "local" })).toBe(true);
	});

	test("login, api-key, subscription, unknown and unset all require credentials", () => {
		for (const access of ["login", "api-key", "subscription", "unknown"] as const) {
			expect(isCredentialFree({ access })).toBe(false);
		}
		expect(isCredentialFree({})).toBe(false);
	});
});
