# PRIME TOKEN HARNESS — PROTOTYPE BENCHMARK REPORT

Status: Deliverable 2 of the Prime Token Harness. Prototype only — nothing is
wired into `createSettingsAwareStreamFn`, no production dispatch or Settings UI
was touched. Numbers below are measured with the prototype's native counting
(approximate byte-proportional mode, the same mode OMP's tokenizer uses under
test), on deterministic synthetic coding-session fixtures.

## 1. Result table (measured 2026-10-08, bun test, agent package)

| Fixture | Baseline tokens | Optimized tokens | Reduction | Ratio | Pipeline latency | Artifacts spilled |
|---|---|---|---|---|---|---|
| short-session (2 msgs, minimal) | 6 | 6 | 0.0% | 1.00x | 0.2 ms | 0 |
| long-session (mixed: CI reruns, JSON, build fail, reasoning, code, recent tail) | 19,357 | 3,959 | **79.5%** | **4.89x** | 1.0 ms | 1 |
| repeated-tool-output (12 identical CI runs) | 9,662 | 4,293 | 55.6% | 2.25x | 0.3 ms | 0 |
| huge-output (10 × large JSON dumps) | 325,349 | 131,342 | 59.6% | 2.48x | 2.3 ms | 1 |
| debug-loop (10 × failing build logs) | 6,521 | 3,461 | 46.9% | 1.88x | 0.2 ms | 0 |

Token values omit the trivial system prompt (identical on both sides).

## 2. What each stage actually did on the fixtures

- **protect** (harness pre-pass): reference-locked system prompt + tool schemas,
  identity-locked recent window (last 8 messages) and the current instruction.
  Verified by tests: mutating any of these fails validation.
- **dedup** (`dedup.exact-tool-outputs`): the repeated-CI fixture's 11 duplicate
  tool outputs after the first were collapsed to reference markers — the 55.6%
  reduction there is almost entirely this stage.
- **select** (`select.age-out-reasoning`): stripped 200-repeat thinking blocks
  from old assistant messages; recent reasoning untouched.
- **suppress** (`suppress.tool-output-budget`, default 1,500 tokens): the huge
  JSON dump (325k→131k) is head-preserving truncation; the full text is written
  to the artifact store and referenced by id in the marker.
- **compress** (`compress.normalize-history`): fence-aware whitespace
  normalization; fenced code blocks proved byte-identical.
- **assemble** (`assemble.pairing-integrity`) + **validate** (`validate.protect-contract`):
  toolCall↔toolResult pairing set, ordering, count, and protected identity all
  asserted; any violation fails open.

Artifact count is 1 (not #suppressed) because the marker write is per-message;
dedup targets are in-memory references to the first occurrence (already retained
on the wire + session JSONL). Only oversized content is spilled to the store.

## 3. Caching implications

- The output is deterministic and idempotent: the idempotence test re-runs the
  pipeline over its own output and observes zero delta.
- The prefix-stability test appends a new turn and re-runs; every message already
  processed in the prior run is **byte- and object-identical**, and the pipeline
  reports the stable prefix token count (`unchangedPrefixTokens` > 0). The one
  message that ages out of the recent window changes exactly once (its first
  suppression), then stabilizes — the CAPC query-agnostic invariant.
- Implication: a provider's prompt cache is invalidated only at the point where
  history ages out of the recent window, not on every request; already-suppressed
  content produces stable prefixes.
- Not yet measured: real provider cache hit-rate against Anthropic/OpenAI
  breakpoints — that requires the integrated stage (out of scope for prototype).

## 4. Failures and fail-open behaviour (verified)

| Scenario | Behaviour | Verified |
|---|---|---|
| Module throws | Whole pipeline returns the ORIGINAL context; `report.failure.module/reason` set; tokens unchanged | pipeline.test "fails open when a module throws" |
| Validation cannot establish safety | Returns ORIGINAL context; recent-window mutation → `failure.module === "validate"` | pipeline.test "fails open when validation cannot establish safety" |
| Module unavailable | Skipped, warning recorded, pipeline continues | pipeline.test "skips unavailable modules with a warning" |
| Harness disabled / shouldProcess false | Pass-through; `report.bypassed === true`; input array untouched | pipeline.test "bypasses when disabled" |
| Input mutation | Harness never mutates the caller's arrays or messages (identity-verified) | pipeline.test "never mutates the input array" |

Adversarial coverage: tool-call pairing survival after suppression; fenced code
byte-fidelity; JSON head staying structurally valid (line-boundary cut); error
lines (`error TS2345`, `Build failed with N errors.`) surviving suppression; exact
duplicate collapse; near no-op on minimal sessions; 100+ message stress within the
500 ms latency ceiling.

## 5. Definitions / caveats

- "Reduction" is provider-facing token volume per request, not session size; the
  session retains full fidelity (first occurrence on the wire, artifacts + session
  JSONL locally). STORE LARGE — SEND SMALL is preserved.
- These are improvement measurements, not targets: 10x/20x figures from research
  remain unclaimed. Real stride comes when the suppressed/dedup layer is combined
  with OMP's compaction, which was not active in this prototype.
- Latencies (< 2.5 ms on the largest fixture) use the cheap approximate counter;
  strict native counting (`PI_TOKENIZER_ACCURATE=1`) will be the production mode
  and may raise latency — to be re-measured at integration.
- No GPU, no learned model, no external dependency in the hot path; `LLMLingua-2`
  as a cold-blob compressor remains an EXPERIMENT, separate from this engine.

## 6. Verdict

The prototype proves the architecture end-to-end: structured messages enter, the
protect contract holds, repeated/noisy content is suppressed deterministically,
failures are visible, original context is never lost, and measurement works. Next
deliverable (3 — Recommendation, per plan) is sequenced after owner review; the
production hook at `createSettingsAwareStreamFn` is intentionally NOT yet wired.