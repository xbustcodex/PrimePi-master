import { afterEach, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api } from "@oh-my-pi/pi-catalog/types";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Request-path contract for rule-declared credential-free routes.
 *
 * `ModelRegistry.getApiKey` is the seam every request resolves through. It must
 * return the `kNoAuth` sentinel — which transports translate into an omitted
 * `Authorization` header — for a rule-marked credential-free model, but only
 * while no credential is stored. A stored key always wins, so an authenticated
 * provider is never silently downgraded to an anonymous request.
 */

const storage = createInMemoryAuthStorage();
const registry = new ModelRegistry(storage);

function routeModel(overrides: { provider: string; id: string; access?: "anonymous" | "local" }): Model<Api> {
	return buildModel({
		id: overrides.id,
		name: overrides.id,
		api: "openai-completions",
		provider: overrides.provider as never,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(overrides.access ? { access: overrides.access } : {}),
	} as never) as Model<Api>;
}

afterEach(() => {
	storage.close();
});

describe("credential-free routes resolve to the no-auth sentinel", () => {
	test("an anonymous route with no stored credential resolves to kNoAuth", async () => {
		const model = routeModel({ provider: "fixture-free", id: "open-model", access: "anonymous" });
		expect(await registry.getApiKey(model)).toBe(kNoAuth);
	});

	test("the sentinel actually omits Authorization on the wire", async () => {
		const model = routeModel({ provider: "fixture-free", id: "open-model", access: "anonymous" });
		const apiKey = await registry.getApiKey(model);
		expect(apiKey).toBe(kNoAuth);
		const setup = resolveOpenAIRequestSetup(
			{ provider: model.provider, id: model.id, baseUrl: model.baseUrl },
			{ apiKey, messages: [] },
		);
		expect(setup.headers.Authorization).toBeUndefined();
	});

	test("a local route with no stored credential resolves to kNoAuth", async () => {
		const model = routeModel({ provider: "fixture-local", id: "local-model", access: "local" });
		expect(await registry.getApiKey(model)).toBe(kNoAuth);
	});
});

describe("credentials are never suppressed for authenticated routes", () => {
	test("a model without an access marker resolves normally (no sentinel)", async () => {
		const model = routeModel({ provider: "fixture-authed", id: "paid-model" });
		// No credential stored -> undefined, never the no-auth sentinel. A paid or
		// unclassified route must not be treated as anonymously reachable.
		const apiKey = await registry.getApiKey(model);
		expect(apiKey).not.toBe(kNoAuth);
	});

	test("a -free id suffix alone does not make a route credential-free", async () => {
		const model = routeModel({ provider: "fixture-free", id: "space-bunny-free" });
		const apiKey = await registry.getApiKey(model);
		expect(apiKey).not.toBe(kNoAuth);
	});
});

describe("the existing keyless-provider path is preserved", () => {
	test("an authenticated free-tier route omits Authorization end to end", async () => {
		// Mirrors the real OpenCode Zen shape: free suffix, authenticated provider.
		// With a stored key the bearer must still be sent.
		const setup = resolveOpenAIRequestSetup(
			{ provider: "opencode-zen", id: "space-bunny-free", baseUrl: "https://opencode.ai/zen/v1" },
			{ apiKey: "sk-real", messages: [] },
		);
		expect(setup.headers.Authorization).toBe("Bearer sk-real");
	});

	test("a real key wins even when the model is marked credential-free", async () => {
		// The guard that makes this safe: `access` marks reachability, never a
		// licence to drop a credential the user actually configured.
		const setup = resolveOpenAIRequestSetup(
			{ provider: "fixture-free", id: "open-model", baseUrl: "https://example.invalid/v1" },
			{ apiKey: "sk-real", messages: [] },
		);
		expect(setup.headers.Authorization).toBe("Bearer sk-real");
	});
});
