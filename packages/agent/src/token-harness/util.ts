/**
 * Deterministic text helpers shared by harness modules.
 *
 * Everything here must be pure and idempotent: the same input always
 * produces the same output so prompt-cache prefixes stay stable across turns
 * (CAPC query-agnostic invariant).
 */

/** Lines that carry failure information and must survive suppression. */
const ERROR_LINE_RE = /\b(error|failed|failure|exception|traceback|fatal|panic|ERR\b|✗|FAILED\b)/i;

export function isErrorLine(line: string): boolean {
	return ERROR_LINE_RE.test(line);
}

/** True when the text already carries a harness marker (idempotence gate). */
export function hasHarnessMarker(text: string): boolean {
	return text.includes("[prime-token-harness:");
}

/**
 * True when `offset` falls inside a fenced code block in `text`.
 * Tracks ``` fences line by line; a fence line itself is considered outside.
 */
export function insideFence(text: string, offset: number): boolean {
	let fenced = false;
	let scanned = 0;
	for (const line of text.split("\n")) {
		const lineEnd = scanned + line.length;
		if (offset <= lineEnd) return fenced;
		scanned = lineEnd + 1;
		if (/^\s*```/.test(line)) fenced = !fenced;
	}
	return fenced;
}

/**
 * Deterministic, fence-aware normalization for lower-sensitivity history:
 * - strips trailing spaces/tabs on lines OUTSIDE code fences
 * - collapses runs of ≥3 blank lines (outside fences) to a single blank line
 *
 * Content inside ``` fences is never touched (code fidelity).
 */
export function normalizeHistoryText(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let fenced = false;
	let blankRun = 0;
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			out.push(line);
			blankRun = 0;
			continue;
		}
		if (fenced) {
			out.push(line);
			blankRun = 0;
			continue;
		}
		const stripped = line.replace(/[ \t]+$/, "");
		if (stripped.length === 0) {
			blankRun++;
			if (blankRun > 1) continue; // keep at most one blank line
			out.push("");
			continue;
		}
		blankRun = 0;
		out.push(stripped);
	}
	return out.join("\n");
}

/**
 * Head-preserving truncation: keeps a deterministic head of the text plus
 * error lines that fall outside the head (up to ~25% of the budget), so a
 * failure that is still being debugged remains visible after suppression.
 *
 * Returns the kept text, or undefined when nothing was removed.
 */
export function truncatePreservingErrors(
	text: string,
	budgetTokens: number,
	countTokens: (t: string) => number,
): { kept: string; removedLines: number; totalLines: number } | undefined {
	const totalTokens = countTokens(text);
	if (totalTokens <= budgetTokens) return undefined;
	const totalLines = text.split("\n").length;
	const headRatio = Math.min(0.75, (budgetTokens * 0.65) / Math.max(1, totalTokens));
	let headChars = Math.max(80, Math.floor(text.length * headRatio));
	// Prefer a line boundary for the head cut.
	const nextNewline = text.indexOf("\n", headChars);
	if (nextNewline !== -1 && nextNewline - headChars < 200) headChars = nextNewline;
	const head = text.slice(0, headChars);
	const headLineCount = head.split("\n").length;

	const errorBudgetChars = Math.floor(text.length * 0.2);
	const keptErrorLines: string[] = [];
	let errorChars = 0;
	const tailLines = text.slice(headChars).split("\n").slice(1); // drop the partial line at the cut
	for (const line of tailLines) {
		if (!isErrorLine(line)) continue;
		if (hasHarnessMarker(line)) continue;
		if (errorChars + line.length > errorBudgetChars) break;
		keptErrorLines.push(line);
		errorChars += line.length;
	}
	// Failed commands nearly always end in a summary line
	// ("Build failed with N errors.", "Process completed with exit code 1.").
	// Keep it even when the mid-body error budget is spent — it is the most
	// actionable signal and cheap (exact dedup guards against marker churn).
	const finalLine = text.trimEnd().split("\n").pop() ?? "";
	if (
		finalLine.trim().length > 0 &&
		isErrorLine(finalLine) &&
		!keptErrorLines.includes(finalLine) &&
		errorChars + finalLine.length <= errorBudgetChars * 1.5
	) {
		keptErrorLines.push(finalLine);
		errorChars += finalLine.length;
	}
	const kept = keptErrorLines.length > 0 ? `${head}\n…\n${keptErrorLines.join("\n")}` : head;
	const removedLines = Math.max(0, totalLines - headLineCount - keptErrorLines.length);
	return { kept, removedLines, totalLines };
}
