import { describe, expect, it } from "bun:test";
import {
	defaultBridgeTransport,
	lanBridgeTransport,
	validateBridgeTransport,
} from "../../src/memory-backend/iai-bridge-transport";

describe("iai bridge transport", () => {
	it("accepts loopback without TLS", () => {
		expect(validateBridgeTransport(defaultBridgeTransport()).ok).toBe(true);
	});

	it("refuses wildcard binds", () => {
		expect(validateBridgeTransport({ bind: "0.0.0.0", port: 8420, tls: null, requireAuth: true }).ok).toBe(false);
	});

	it("refuses LAN plaintext and accepts LAN with TLS", () => {
		const plaintext = lanBridgeTransport("192.168.1.104", 8420, null);
		expect(validateBridgeTransport(plaintext).ok).toBe(false);

		const tls = lanBridgeTransport("192.168.1.104", 8420, {
			certPath: "/srv/buster/iai-memory/tls/bridge.crt",
			keyPath: "/srv/buster/iai-memory/tls/bridge.key",
		});
		expect(validateBridgeTransport(tls).ok).toBe(true);
	});

	it("always requires authentication", () => {
		expect(validateBridgeTransport({ bind: "127.0.0.1", port: 8420, tls: null, requireAuth: false }).ok).toBe(false);
	});
});
