import { describe, expect, it } from "bun:test";
import { longSessionFixture } from "./fixtures";
import { runTokenHarness, InMemoryArtifactStore } from "@oh-my-pi/pi-agent-core";

describe("token-harness Phase E A/B comparison", () => {
	it("fixture comparison: disabled preserves tokens, enabled applies reduction", () => {
		const input = longSessionFixture();

		// Disabled mode: harness skips optimization, returns original context
		// 'ok: false' means "optimization not applied", not a failure;
		// the invariant is: outputTokens === inputTokens, reductionPct === 0
		const resultA = runTokenHarness(
			{ ...input, messages: [...input.messages] },
			{ enabled: false, artifactStore: new InMemoryArtifactStore() },
		);
		expect(resultA.report.outputTokens).toBe(resultA.report.inputTokens);
		expect(resultA.report.reductionPct).toBe(0);

		// Enabled mode: optimization may have been applied
		const resultB = runTokenHarness(
			{ ...input, messages: [...input.messages] },
			{ enabled: true, artifactStore: new InMemoryArtifactStore() },
		);
		expect(resultB.ok).toBe(true);
		expect(resultB.report.reductionPct).toBeGreaterThan(0);
		expect(resultB.report.outputTokens).toBeLessThanOrEqual(
			resultB.report.inputTokens,
		);
	});
});