import type { ArtifactRef, ArtifactStore } from "./contract";

/**
 * Default prototype artifact store: in-memory, per pipeline run.
 *
 * At integration time this is replaced by (or adapted to) the coding-agent's
 * existing artifact-spill infrastructure (`tools/output-meta.ts`
 * spillLargeResultToArtifact), which persists to the session directory. The
 * prototype keeps the same interface so the swap is a wiring change only.
 */
export class InMemoryArtifactStore implements ArtifactStore {
	readonly #texts = new Map<string, string>();
	#counter = 0;

	put(text: string, meta: { messageIndex: number; toolName?: string }): ArtifactRef {
		const id = `pth:a${++this.#counter}:${meta.messageIndex}`;
		this.#texts.set(id, text);
		return { id, messageIndex: meta.messageIndex, tokens: 0, bytes: Buffer.byteLength(text, "utf-8") };
	}

	get(id: string): string | undefined {
		return this.#texts.get(id);
	}
}
