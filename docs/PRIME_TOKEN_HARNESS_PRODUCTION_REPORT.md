# PRIME TOKEN HARNESS — DELIVERABLE 3 PRODUCTION-READINESS REPORT

Status: integration + shadow mode implemented behind the single inference seam,
disabled by default, committed separately from Wave 1 model-authority work.
Recommendation at the end: **SHADOW-ONLY first, then controlled activation.**

## E.1 Actual files changed (harness commit 6369c24e53)

**New — package `@oh-my-pi/pi-agent-core` (packages/agent):**
- `src/token-harness/contract.ts` — module contract, state, config, report types.
- `src/token-harness/pipeline.ts` — engine: protect pre-pass, stage ordering, health
  gating, latency watchdog, fail-open, bypass, stats.
- `src/token-harness/artifacts.ts` — `InMemoryArtifactStore` (prototype default).
- `src/token-harness/util.ts` — fence-aware normalization, error-line/truncation helpers.
- `src/token-harness/modules/{dedup,select,suppress,compress,assemble,validate}.ts`.
- `src/index.ts` — barrel export (`export * from "./token-harness"`).

**New — package `@oh-my-pi/pi-coding-agent` (packages/coding-agent):**
- `src/session/token-harness-integration.ts` — settings registration
  (`tokenHarness.enabled`, `tokenHarness.shadowEnabled`, both default false,
  config-file only, no Settings UI), `PersistedTokenHarnessStore`
  (content-hash ids, Windows-safe filenames), `decideTokenHarness`,
  stats accumulator, local-runtime bypass, default store wiring.
- `test/token-harness-integration.test.ts` — 5 integration contracts.

**Modified — coding-agent:**
- `src/session/settings-stream-fn.ts` — single seam hook (diff is +10 lines).

**New — tests & docs:** `packages/agent/test/token-harness/*` (4 files incl.
resume traversal), `docs/PRIME_TOKEN_HARNESS_ARCHITECTURE.md`,
`docs/PRIME_TOKEN_HARNESS_BENCHMARK.md`.

Unchanged/preserved: all Wave 1 model-authority work remains uncommitted but
intact; no provider adapter, session storage, or Settings UI code was touched.

## E.2 Integration call chain

```
AgentSession turn / advisor runtime
  → createSettingsAwareStreamFn(settings, base)      [session/settings-stream-fn.ts]
      ├─ reads provider/guard settings per call
      ├─ decideTokenHarness(settings, model, context, tokenizer)  [session/token-harness-integration.ts]
      │    ├─ off (default) / bypass (ollama-chat, apple-foundation-models) → dispatch original context
      │    ├─ shadow → runTokenHarness() records savings; dispatch ORIGINAL context
      │    └─ active → runTokenHarness(); fail-open if !ok; else dispatch harness context
      └─ base(model, context, merged)                [streamSimple]
           → pi-ai stream → (existing transforms) → provider adapter → ONLINE provider
```

The seam covers every coding-agent online inference (main, subagent, advisor,
compaction one-shots) with `Model`, `Context` and a per-encoding `Tokenizer`
already in scope. No provider adapter duplication.

## E.3 Tests and build results

| Gate | Result |
|---|---|
| agent harness tests | 23/23 pass (pipeline contracts, adversarial, resume, benchmark) |
| coding-agent integration | 5/5 pass (default-off, shadow, active, bypass, persisted store) |
| `@oh-my-pi/pi-agent-core` check (lint+fmt+types) | pass |
| `@oh-my-pi/pi-coding-agent` check:types (incl. Wave 1 code) | pass |
| Commit hygiene | harness-only commit; Wave 1 files left uncommitted intact |

## E.4 Shadow-mode results (recorded, not yet production-observed)

The integration test proves the shadow path: with `tokenHarness.shadowEnabled:true` the
provider receives the byte-identical original context while the harness records
>20% proposed reduction on the tool-heavy fixture. `getTokenHarnessStats()` exposes
counters (`shadow`, `active`, `bypassed`, input/output token sums, last report) for
diagnostics. Production shadow numbers require the owner running the app against real
sessions (verification debt, E.9); the harness never alters what is sent in shadow.

Prototype benchmark (deterministic fixtures, from the committed benchmark report):

| Fixture | baseline → optimized | reduction | latency |
|---|---|---|---|
| long-session (mixed) | 19,357 → 3,959 | 79.5% (4.89x) | 1.0 ms |
| repeated CI output | 9,662 → 4,293 | 55.6% (2.25x) | 0.3 ms |
| huge JSON dumps | 325,349 → 131,342 | 59.6% (2.48x) | 2.3 ms |
| debug-loop | 6,521 → 3,461 | 46.9% (1.88x) | 0.2 ms |
| minimal session | 6 → 6 | 0.0% | 0.2 ms |

## E.5 Cache effects

- Output is deterministic and idempotent (re-run over own output ⇒ zero delta) and
  the leading processed run is byte-stable across appended turns — verified by
  `pipeline.test.ts` "prefix stable across appended turns" and `resume.test.ts`
  "output deterministic over a JSON round-trip".
- Implication: provider prompt-cache prefixes are only invalidated at the point a
  message ages out of the recent window, not per request (CAPC query-agnostic rule).
- Real hit-rate vs provider billing is **not yet measured** (needs live integration) —
  verification debt.

## E.6 Recovery and failure behavior

- Fail-open: any module throw or validation violation returns the ORIGINAL messages;
  the integration forwards the original context on `!ok`. The ENOENT-writing bug found
  during integration (Windows `:` filename) surfaced as exactly this graceful
  fail-open and was fixed in the store.
- Artifacts: content-addressed files under `<agentDir>/token-harness/`; suppressed
  output is recoverable by id from a fresh store instance (verified). Marker ids are
  embedded in the on-wire text, so a later retrieval stage can resolve them.
- Resume: markers and pairing survive a JSON round-trip (storage → resume → re-run),
  verified in `resume.test.ts`. Session JSONL is never mutated by the harness (the
  request context is a working copy).
- Determinism of artifacts: identical content ⇒ identical id ⇒ no duplicate writes.

## E.7 Phase A adversarial-verification items

| Item | Status |
|---|---|
| 1 dedup refs resolvable after resume/compaction/restart | Markers survive JSON round-trip; artifact files persist across store instances. Compaction-drop interaction untested live → debt. |
| 2 artifact refs beyond in-memory store | `PersistedTokenHarnessStore` implemented + tested (fresh-instance recovery). |
| 3 suppressed output recoverable | Verified (`store.get(id)`, deterministic ids). |
| 4 tool-call/result pairing survives | Verified in adversarial + resume + assemble-contract. |
| 5 protected instruction/turns/errors/code intact | Verified: identity-locked protect, error-line retention, fence byte-fidelity. |
| 6 prompt-cache reuse improves/degrades | Determinism + prefix-stability proven; real provider hit-rate → debt. |
| 7 tokenizer ≈ provider-billed | Approximate counting is the established in-repo convention; exact billing comparison → debt (needs live requests; no paid calls allowed). |
| 8 timeouts interrupt expensive processing | Not interruptible: modules are synchronous CPU; watchdog detects + records elapsed and can fail the run, but cannot preempt mid-module. Kept CPU-cheap by design; heavier compressors must run off-thread (rework item). |

## E.8 Token reduction measurements, provider eligibility, safety

- No paid calls were made. No provider adapter, credential, or OpenCode auth code was
  touched. Model/provider eligibility and the Wave-1 paid-usage policy
  (`policyAllowsPaid`) are untouched by the harness.
- Bypass categories: on-device runtimes (`ollama-chat`, `apple-foundation-models`).
  Custom local OpenAI-compatible servers are not yet classified — they remain
  fail-open-correct; catalog-owned classification (KDL) is the planned refinement.

## E.9 Remaining verification debt (blocks ENABLE)

1. Live shadow accumulation over real sessions (owner runs the app with
   `tokenHarness.shadowEnabled: true`) — collect realistic input/output/reduction
   and confirm zero behavioural difference.
2. Tokenizer estimate vs provider-billed input tokens (one model/provider pair).
3. Prompt-cache hit-rate with active mode against at least one caching provider.
4. Agent-task-completion A/B (optimized vs unoptimized) on representative tasks
   (Phase D gate).
5. Interaction of suppression markers with edit seen-line guards / tool-result replay
   on real history.
6. Module interruption semantics (currently detect-only) if a heavy compressor is
   ever added.

## E.10 Recommendation

**KEEP SHADOW-ONLY (implemented and committed), do not enable active compression
globally yet.**

Rationale: the architecture is proven and safe (fail-open, deterministic, asset
preserved, Wave 1 untouched), and shadow mode collects real evidence with zero
behavioural risk. Enabling active mode before items 1-4 of E.9 are measured would
risk the Phase-D gates (cache regression, task-completion regression) without
provider-backed evidence. Next step after owner review: run the app in shadow across
the owner's sessions, then feed that data into the Phase-D A/B before flipping
`tokenHarness.enabled` to true in controlled settings.