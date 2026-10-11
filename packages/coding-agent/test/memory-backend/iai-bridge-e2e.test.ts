import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { bridgeRequest, readBridgeTokenFile } from "../../src/memory-backend/iai-bridge-tcp-client";

/**
 * Live end-to-end bridge test through the SSH tunnel.
 *
 * Gated: runs only when IAI_BRIDGE_E2E=1 with IAI_BRIDGE_HOST/PORT and
 * IAI_BRIDGE_TOKEN_FILE set. Uses a unique throwaway bank per run and
 * leaves no credentials in output. Restart persistence, queue drain, and
 * the backup drill are driven operationally (see Stage 3 report).
 */
const ENABLED = process.env.IAI_BRIDGE_E2E === "1";
const HOST = process.env.IAI_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IAI_BRIDGE_PORT ?? "18420");
const TOKEN_FILE = process.env.IAI_BRIDGE_TOKEN_FILE ?? "";

describe.skipIf(!ENABLED)("iai bridge live e2e", () => {
	it("archives and retrieves a unique memory with enforced auth and scope", async () => {
		const token = await readBridgeTokenFile(TOKEN_FILE);
		const options = { host: HOST, port: PORT, token };
		const stamp = Date.now().toString(36);
		const bank = `e2e-${stamp}`;
		const key = `e2e-key-${stamp}`;
		const content = `e2e probe ${stamp} quokka lonestar`;
		const idem = `e2e-idem-${stamp}`;

		const health = await bridgeRequest(options, "health", {}, `health-${stamp}`);
		expect(health.kind).toBe("health-result");

		const archive = await bridgeRequest(
			options,
			"archive",
			{
				key,
				bank,
				projectId: bank,
				sessionId: `e2e-session-${stamp}`,
				contentHash: createHash("sha256").update(content).digest("hex"),
				bytes: content.length,
				idempotencyKey: idem,
				version: 0,
				content,
			},
			`archive-${stamp}`,
		);
		expect(archive.kind).toBe("archive-ack");
		const ack = archive.body as Record<string, unknown>;
		expect(ack.durable).toBe(true);

		const recall = await bridgeRequest(
			options,
			"recall",
			{ query: "quokka lonestar", bank, projectId: bank, limit: 10 },
			`recall-${stamp}`,
		);
		expect(recall.kind).toBe("recall-result");
		const items = (recall.body as { items: Array<{ key: string; bridgeKey?: string }> }).items;
		expect(items.some(item => item.bridgeKey === key)).toBe(true);

		const duplicate = await bridgeRequest(
			options,
			"archive",
			{
				key,
				bank,
				projectId: bank,
				sessionId: `e2e-session-${stamp}`,
				contentHash: createHash("sha256").update(content).digest("hex"),
				bytes: content.length,
				idempotencyKey: idem,
				version: 0,
				content,
			},
			`archive-dup-${stamp}`,
		);
		expect((duplicate.body as Record<string, unknown>).duplicate).toBe(true);

		const badAuth = await bridgeRequest(
			{ host: HOST, port: PORT, token: "wrong-token" },
			"recall",
			{ query: "quokka", bank, projectId: bank, limit: 5 },
			`recall-bad-${stamp}`,
		);
		expect(badAuth.kind).toBe("error");

		const crossProject = await bridgeRequest(
			options,
			"recall",
			{ query: "quokka lonestar", bank, projectId: "unrelated-project", limit: 10 },
			`recall-xproj-${stamp}`,
		);
		const xItems = (crossProject.body as { items: Array<{ key: string; bridgeKey?: string }> }).items;
		expect(xItems.some(item => item.bridgeKey === key)).toBe(false);
	});
});
