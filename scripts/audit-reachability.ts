#!/usr/bin/env bun
/**
 * Minimal production-reachability audit (Wave 0 evidence foundation).
 *
 * For every module path passed on the CLI, verify that at least one
 * non-test production module imports it. A module whose only importers are
 * tests (or that has none) is constructed but inert — "implementation
 * exists ≠ production reachable".
 *
 * Usage:
 *   bun scripts/audit-reachability.ts packages/coding-agent/src/tools/ask.ts [more paths...]
 *
 * Exit 1 when any listed module fails the check, and print the evidence.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
const targets = process.argv.slice(2);
if (targets.length === 0) {
	console.error("usage: bun scripts/audit-reachability.ts <module-path> [...]");
	process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".artifacts"]);
const files: string[] = [];

function walk(dir: string): void {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full);
		else if (/\.(ts|tsx|mjs)$/.test(entry)) files.push(full);
	}
}

walk(join(ROOT, "packages"));

const normalizedTargets = new Set(
	targets.map(t =>
		t
			.replace(/\\/g, "/")
			.replace(/^\.\//, "")
			.replace(/\.(ts|tsx|mjs)$/, ""),
	),
);
const prodHits = new Map<string, string[]>();
const testHits = new Map<string, number>();

for (const file of files) {
	const text = readFileSync(file, "utf8");
	if (!text.includes("from")) continue;
	for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
		const spec = m[1];
		if (!spec.startsWith(".") && !spec.startsWith("@")) continue;
		const clean = spec.replace(/\.(js|mjs|ts|tsx)$/, "").replace(/\\/g, "/");
		const resolved = spec.startsWith(".")
			? join(file, "..", clean)
					.replace(/\\/g, "/")
					.replace(/\/packages\//, "/packages/")
					.replace(/^C:/, "C:")
			: clean;
		for (const target of normalizedTargets) {
			if (resolved.endsWith(target) || target.endsWith(resolved)) {
				if (/\.test\.|\.spec\.|[/\\]test[/\\]|[/\\]tests[/\\]/.test(file)) {
					testHits.set(target, (testHits.get(target) ?? 0) + 1);
				} else {
					const list = prodHits.get(target) ?? [];
					list.push(file);
					prodHits.set(target, list);
				}
			}
		}
	}
}

let failed = false;
for (const target of targets) {
	const key = target
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\.(ts|tsx|mjs)$/, "");
	const prod = prodHits.get(key) ?? [];
	if (prod.length === 0) {
		failed = true;
		console.log(`INERT  ${target}  (test importers: ${testHits.get(key) ?? 0})`);
	} else {
		console.log(`LIVE   ${target}  <- ${prod[0]}${prod.length > 1 ? ` (+${prod.length - 1})` : ""}`);
	}
}
process.exit(failed ? 1 : 0);
