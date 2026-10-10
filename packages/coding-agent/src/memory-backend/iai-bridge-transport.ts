/**
 * Authenticated transport configuration for the IAI long-term memory bridge.
 *
 * Security posture:
 * - Bearer tokens are never sent over an unencrypted connection. Loopback
 *   binds are exempt (no network traversal); any non-loopback bind requires
 *   TLS with an explicit certificate and key.
 * - `0.0.0.0` binds are refused outright: the bridge binds either loopback
 *   (local testing) or one explicit LAN address (e.g. 192.168.1.104).
 * - Authentication is always required; there is no anonymous mode.
 *
 * Pure validation lives here so misconfiguration fails closed at startup
 * with an actionable message instead of silently serving plaintext.
 */

export interface IaiBridgeTlsConfig {
	certPath: string;
	keyPath: string;
}

export interface IaiBridgeTransportConfig {
	bind: string;
	port: number;
	tls: IaiBridgeTlsConfig | null;
	requireAuth: boolean;
}

export const IAI_BRIDGE_DEFAULT_PORT = 8420;

function isLoopbackAddress(bind: string): boolean {
	return bind === "127.0.0.1" || bind === "::1" || bind.toLowerCase() === "localhost";
}

function isWildcardAddress(bind: string): boolean {
	return bind === "0.0.0.0" || bind === "::";
}

/** Default transport: loopback only, auth required, no TLS needed. */
export function defaultBridgeTransport(port: number = IAI_BRIDGE_DEFAULT_PORT): IaiBridgeTransportConfig {
	return { bind: "127.0.0.1", port, tls: null, requireAuth: true };
}

/** LAN transport: explicit address plus TLS. Refused without a certificate. */
export function lanBridgeTransport(
	bind: string,
	port: number,
	tls: IaiBridgeTlsConfig | null,
): IaiBridgeTransportConfig {
	return { bind, port, tls, requireAuth: true };
}

export interface TransportValidation {
	ok: boolean;
	error?: string;
}

/** Fail-closed validation for a bridge transport configuration. */
export function validateBridgeTransport(config: IaiBridgeTransportConfig): TransportValidation {
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
		return { ok: false, error: "port must be an integer between 1 and 65535" };
	}
	if (config.bind.length === 0) return { ok: false, error: "bind address must not be empty" };
	if (isWildcardAddress(config.bind)) {
		return { ok: false, error: "wildcard binds are refused; use loopback or one explicit address" };
	}
	if (!config.requireAuth) return { ok: false, error: "authentication is always required" };
	if (!isLoopbackAddress(config.bind) && config.tls === null) {
		return { ok: false, error: "non-loopback binds require TLS; bearer tokens never travel plaintext" };
	}
	if (config.tls !== null && (config.tls.certPath.length === 0 || config.tls.keyPath.length === 0)) {
		return { ok: false, error: "TLS requires both certPath and keyPath" };
	}
	return { ok: true };
}
