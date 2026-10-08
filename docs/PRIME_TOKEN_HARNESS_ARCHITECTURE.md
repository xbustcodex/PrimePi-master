# PRIME TOKEN HARNESS — ARCHITECTURE

Status: investigation deliverable (no production changes made by this document).
Scope: ONLINE / API model inference only. Local (Ollama/local-model) inference, KV-cache
compression, tool harness, settings UI: out of scope.

Invariant this design targets:

> NEVER SEND AN UNSUPPRESSED PROVIDER REQUEST WHEN PRIME TOKEN HARNESS IS ACTIVE.
> STORE LARGE. RETRIEVE PRECISELY. SEND SMALL.

---

## A. CURRENT PRIMEPI/OMP PATH (actual flow, verified against source)

All paths below are in the OMP tree (`C:\Users\xkali\new_ai\oh-my-pi`), which is the
PrimePi application baseline.

### 1. Turn → context construction

- `packages/coding-agent/src/session/agent-session.ts` — `AgentSession` owns the turn
  lifecycle: queued messages, prompt sequence/generation, history, subagents, memory
  recall injection (`_recallMemoryForTurn`), and persistence. It prepares each turn and
  drives the agent.
- `packages/agent/src/agent-loop.ts` — `AgentLoop.step()` builds the per-call request
  from `this.state.messages` (canonical message array: system prompt, history, tool
  calls/results, queued user messages) plus `model`, `tools`, `thinking`, and invokes
  the injected `streamFn`.
- `packages/coding-agent/src/session/session-context*.ts` / maintenance — session
  context summary and effective history slicing feed the loop.

### 2. Compaction / pruning (existing, preserved as-is)

- `packages/coding-agent/src/session/session-maintenance.ts` — auto-compaction
  (threshold/overflow/idle), `shake` (drops images/thinking/tool results wholesale),
  snapcompact (text→PNG frame imaging via `packages/snapcompact/`), context-fit checks
  (`contextFitsModel`).
- `packages/agent/src/compaction*` and output budget
  (`packages/agent/src/output-budget.ts`) bound generations.
- PrimePi port already in flight (Wave 1/6 blueprint): stale-tool-result pruning
  persisted as `context_edit` entries (from PrimePi `core/compaction/pruning.ts`).

**Today's model:** compaction is *threshold-driven emergency* (grow → near-limit →
compact). It is not always-on per-request reduction. The harness sits EARLIER in the
path and does not replace this.

### 3. Provider request path (the wire)

```
AgentSession (turn prep, session state)
  → AgentLoop.step()            [packages/agent/src/agent-loop.ts]
  → streamFn = createSettingsAwareStreamFn(...)   [packages/coding-agent/src/session/settings-stream-fn.ts]
  → streamSimple()/stream()     [packages/ai/src/stream.ts]
      - existing message transforms run here:
        credential redaction / projection
        withCredentialRedaction [packages/ai/src/providers/transform-messages.ts]
        image hoisting, thinking strips, role mapping, API dialect fixes
  → provider adapter            [packages/ai/src/providers/*]
      (openai-completions, openai-responses, anthropic-messages, google, bedrock,
       opencode gateways, openrouter, …)
  → HTTP/SSE dispatch
```

Every online provider call funnels through `packages/ai/src/stream.ts` and the
adapter layer. The coding-agent-scoped funnel is
`createSettingsAwareStreamFn` — it sees the request for **every** coding-agent model
call (primary, subagent, advisor, compaction, handoff one-shots) before any
provider-specific serialization.

### 4. Response → tools → history

- Stream events → `AgentLoop` accumulates assistant content/tool calls, executes
  tools (`packages/coding-agent/src/tools/*`), appends assistant + tool-result
  messages to `state.messages`, persists to session JSONL
  (`packages/coding-agent/src/session/session-storage.ts` and session manager), and
  loops.
- **Next call resends `state.messages` in full** unless maintenance/compaction/shake
  changed it. This is the resend problem the harness attacks.

### 5. What is already stored locally at full fidelity (and whether it is resent)

| Store | File | Full fidelity local? | Resent to provider today? |
|---|---|---|---|
| Session JSONL | `session/session-storage.ts` (+ loader/manager) | yes | yes — unless compaction/shake replaced it |
| Artifact spill (big tool outputs) | `tools/output-meta.ts` (`spillLargeResultToArtifact`) | yes, on disk | only the truncated form + reference (already a STORE LARGE/SEND SMALL instance) |
| Blob broker | `blob-broker/*` | yes | references/hoisted uploads only |
| Snapcompact PNG frames | `snapcompact/` + `session/session-maintenance.ts` | yes | frames not resent raw; summary carries the compressed representation |
| Memory backends | `memory-backend/`, `src/mnemopi|hindsight|sharpshooter` | yes | only bounded recall blocks (already bounded) |

**Key observation:** OMP already contains several *local, always-on* reduction
mechanisms (artifact spill, shake, snapcompact, bounded recall). What is missing is a
single always-on, per-request, structurally-aware pipeline between session state and
the wire.

### 6. Existing capabilities a harness reuses (do not rebuild)

- **Token counting:** native `countTokens` in `packages/natives`, wrapped by
  `packages/agent/src/tokenizer.ts` (strict/approximate modes).
- **Output budget:** `packages/agent/src/output-budget.ts`.
- **Prompt caching:** provider adapters already emit `cache_control` /
  prompt-cache structures (anthropic adapter; prompt cache handling in
  `packages/ai/src/*`).
- **Redaction/transform pipeline:** `packages/ai/src/providers/transform-messages.ts`
  — proves a structural, always-on message transform already runs; the harness
  composes with it.
- **Artifact spill / output-meta:** precedent + plumbing for replacing large tool
  outputs with references.
- **Compaction/shake/snapcompact:** emergency + coarse reduction (kept as fallback).
- **Message fingerprints:** session dedup helpers (`message-fingerprint` utilities).

---

## B. COMMON HOOK POINT (narrowest always-on online boundary)

Candidates evaluated:

| # | Location | Coverage | Verdict |
|---|---|---|---|
| c | `createSettingsAwareStreamFn` wrapper, `session/settings-stream-fn.ts` | every coding-agent model call, coding-agent scope, has session/settings/model context | **PRIMARY** |
| a | `packages/ai/src/stream.ts` (`streamSimple`/`stream`) | every caller of pi-ai, every provider, all packages | **ENFORCEMENT NET** (optional second gate / SDK coverage) |
| b | `AgentLoop.step()` in `packages/agent` | agent-layer, before settings wrapper | too early, no provider/settings context |
| d | per-provider adapters | near wire, but N call sites, easily missed | reject as primary |

**Decision:** the harness contract is installed at **(c)** as the primary hook — it is
the narrowest point that covers all coding-agent online inference with session context
— and optionally asserted at **(a)** as a cheap invariant check (reject/telemetry if an
unprocessed request reaches `stream.ts` while the harness is active). Provider/adapter
levels remain untouched.

Order relative to existing transforms: harness runs **before** pi-ai's
`transformMessages()`/redaction (it operates on the structured session messages), so
existing safety transforms still apply afterwards, unchanged. Local/ollama exclusion:
decided at the hook by provider/kind classification from `packages/catalog`
(`Model.provider` / model class), so local endpoints bypass the pipeline by config,
never by special-casing a string.

---

## C. EXISTING PRIMEPI/OMP CAPABILITIES TO REUSE

1. `createSettingsAwareStreamFn` — the hook.
2. Native token counting (`countTokens`, `tokenizer.ts`) — measurement + validate stage.
3. Artifact spill (`output-meta.ts`) — the local store for evicted large outputs.
4. Session JSONL + `context_edit` pruning provenance (Wave 6 port) — full-fidelity
   local retention of anything suppressed from the wire.
5. Compaction/shake/snapcompact — coarse fallback layers, preserved.
6. `transform-messages` pipeline — composition point; harness must not bypass it.
7. Bounded memory recall — already-sent-small pattern.
8. Prompt-cache emission in adapters — the CAPC stage must cooperate with it.
9. Settings registry (config-only keys; **no settings UI** — per owner rule).

---

## D. TECHNOLOGY MATRIX

| Technology | Lang | GPU? | Black-box OK | Latency | Stage | Verdict |
|---|---|---|---|---|---|---|
| LLMLingua v1 | Python (MIT) | CPU-possible / GPU typical | yes | up to ~21 s @48k (A100) | compress | **REJECT** (dep) |
| LongLLMLingua | Python (MIT) | same | yes | same + ranking | select→compress | **REJECT** (query-aware ⇒ cache-hostile per CAPC) |
| LLMLingua-2 | Python (MIT) | CPU OK (BERT) | yes | ~0.1–1.3 s @4k; 1–5 s CPU | compress | **EXPERIMENT** (time-boxed, cold blobs only) |
| `@atjsh/llmlingua-2` (TS port) | TS (MIT) | DirectML/CUDA/WebGPU, no tuned CPU | yes | model-load + ms–s | compress | EXPERIMENT (candidate vehicle) |
| Selective Context | Python (MIT?) | CPU (GPT-2) | yes | ~46 ms/para | select/suppress | **REJECT** (dep; dominated by LLMLingua-2) — principle → native |
| CAPC (arXiv 2607.15516) | paper | — | yes | 0 (policy) | assemble (cache policy) | **ACCEPT** (as policy) |
| MemGPT (arXiv 2310.08560) | paper | — | yes | — | select (tiering) | **ACCEPT** (as principle) |
| AutoCompressors | Python, no license | A100 training/infer | **no** (soft prompts) | GPU | — | **REJECT** |
| ICAE | Python (CC0) | GPU (LoRA) | **no** (embedding slots) | GPU | — | **REJECT** |
| 500xCompressor | Python (CC-BY) | GPU (KV injection) | **no** | GPU | — | **REJECT** |
| `prompt-compressor` (npm) | TS (MIT, 0-dep) | no | yes | ms | suppress/dedup | **EXPERIMENT** (vendor rules, don't depend) |
| vLLM semantic-router `promptcompression` (Go) | Go | no (TF-IDF/position) | yes | ms | select | reference pattern only |

Provider-practice findings that shape the design (see research annex):

- **Tool-result clearing is the universal first move** (Anthropic context editing,
  Claude Code micro-compaction "[Old tool result content cleared]", AWS Strands
  1,500-token hard cutoff, Microsoft `ToolResultCompactionStrategy`, OpenCode V1
  prune). Cheapest, deterministic, biggest win.
- **CAPC evidence:** query-aware compression (the whole LLMLingua family) *invalidates
  prefix caching* and measured +40% cost vs vanilla on tau-bench. Compression over the
  shared prefix must be **query-agnostic** and cache-tier-bounded.
- **Threshold summarization stays** (85%/80%/150k conventions) — that is OMP's existing
  compaction; keep it.
- **Payload referencing** (Gemini Files API URIs, Anthropic memory tool, MemGPT paging)
  — the harness's artifact-reference form.
- Learned compressors that need decoder access (AutoCompressors/ICAE/500x) are
  structurally impossible against black-box APIs.

---

## E. PROPOSED HARNESS CONTRACT (real TypeScript, module `prime-token-harness`)

Location (proposed): `packages/agent/src/token-harness/` (protocol) with
coding-agent wiring in `session/settings-stream-fn.ts`. No UI. Config via settings
registry keys only.

```ts
// Capabilities a module declares; the harness skips modules it cannot run.
type StageKind = "protect" | "dedup" | "select" | "suppress" | "compress" | "assemble" | "validate";

interface HarnessModule {
	readonly name: string;            // stable id, e.g. "rule.suppress-tool-outputs"
	readonly version: string;
	readonly stage: StageKind;        // pipelines compose stage → stage
	readonly priority: number;        // lower runs earlier within a stage
	readonly capabilities: {
		readonly accepts: readonly MessageShape[]; // "user" | "assistant" | "tool-result" | "system" | "image"
		readonly cpuOnly?: boolean;
		readonly maxLatencyMs?: number;
	};
	health(): ModuleHealth;           // available | degraded | unavailable (+reason)
	estimate(input: HarnessInput): TokenEstimate;   // cheap pre-check (native countTokens)
	process(input: HarnessInput, ctx: HarnessContext): Promise<HarnessResult>;
	validate?(result: HarnessResult): ValidationResult;
	shutdown?(): Promise<void>;
}

interface HarnessInput {
	messages: readonly AgentMessage[];  // structured array — NOT a flat string
	system: string;
	tools: ToolSchema[];               // protected by contract
	model: { id: string; provider: string; free?: boolean };  // for local exclusion
	turn: { currentInstruction: string; requiresTools: boolean };
	budget?: { maxProviderTokens?: number };
}

interface HarnessResult {
	messages: AgentMessage[];
	report: {
		inputTokens: number; outputTokens: number; reductionRatio: number;
		latencyMs: number;
		protectedElements: ProtectedRef[];  // ids of content guaranteed intact
		warnings: string[]; failure?: { module: string; reason: string };
		localArtifacts: ArtifactRef[];      // what was kept locally (STORE LARGE)
	};
	// failover: if a module throws, harness returns prior state + failure marker
}

interface HarnessContext {
	logger; counters; clock: () => number;   // injectable for tests
	localStore: ArtifactStore;               // write-through store for evicted content
	config: HarnessConfig;                   // from settings registry (no UI)
}
```

Rules encoded in the contract:

- **Protect is not a plugin's option — it is the harness's pre-pass.** The harness
  marks protected items (current user instruction, system prompt sections, tool
  schemas, plan-protected content, exact-code regions under edit, identifiers/paths/JSON
  in the current task frame) before any module runs; modules may only report they
  *failed* to preserve them — `validate` then hard-fails the request into the
  conservative path (pass-through unsuppressed + warning), never into a broken request.
- **Failure behavior:** module unavailable → skip (health() gate). Module throws →
  drop its delta, keep prior messages, record `failure`. Final validate fails →
  **fail open to the original request** (never destroy an inference), emit audit
  counter. Latency watchdog per module (`maxLatencyMs`), process-level budget.
- **Determinism/caching:** modules in the shared-prefix path must be
  **query-agnostic** (same input → same output across turns) per CAPC.

---

## F. PROPOSED PIPELINE

Stage order (initial model, modular — each stage = one or more swappable modules):

```
PROTECT     (harness pre-pass: mark/extract immutable content)
   ↓
DEDUPLICATE (exact/fuzzy line+block dedup; collapse repeated tool output to refs)
   ↓
SELECT      (message-tier policy: keep newest N turns verbatim; older tiers →
             summarize/evict; tool results evict first, then stale reasoning)
   ↓
SUPPRESS    (per-tool output budgets: head-preserving truncation + omission marker
             + full text written to local artifact; stale/resolved-error stripping)
   ↓
COMPRESS    (deterministic text normalization on LOW-sensitivity material only:
             whitespace, comment/docstring strip, log-noise strip, JSON minify —
             never code semantics, never current-error content)
   ↓
ASSEMBLE    (cache-aware: stable prefix preserved, query-agnostic over shared prefix,
             CAPC r_max floor, provider cache_breakpoints respected; rebuild valid
             message array with pairing integrity assistant↔tool_result)
   ↓
VALIDATE    (protected-element assertion via native countTokens; budget check;
             prefix-diff/cache check; structural pairing check; report emitted)
   ↓
dispatch → settings-stream-fn → pi-ai transformMessages (redaction etc.) → adapter → provider
```

Stage ownership vs existing OMP layers:

- Harness `select`/`suppress` operate on the request **per call** without mutating
  session state (pure request shaping). Durable reduction (actually removing from
  session history) remains the domain of existing compaction/shake — the harness
  proposes, session state decides.
- Existing compaction threshold stays as the fallback layer underneath.

---

## G. DATA-FLOW DIAGRAM

```
PrimePi session state (FULL FIDELITY: session JSONL + artifacts + blob-broker + memory)
        │
        │  AgentLoop.step() assembles state.messages
        ▼
createSettingsAwareStreamFn  ←── HOOK (always-on when harness active)
        │
        ▼
PRIME TOKEN HARNESS
  protect → dedup → select → suppress → compress → assemble → validate
        │                                    │
        │  evicted content ──────────────► local ArtifactStore (reference: artifact A17)
        │                                    │  (retrievable on demand)
        ▼                                    │
MINIMUM SUFFICIENT REQUEST ◄─────────────────┘  (summary: "test-output: 294 passed")
        │
        ▼
pi-ai stream.ts → transformMessages (redaction/image/roles — unchanged)
        │
        ▼
provider adapter → ONLINE PROVIDER  (cache-friendly stable prefix + small suffix)
        │
        ▼
response → AgentLoop → tools → history appended to session state (full fidelity)
        │
        └── next inference: harness sees full state again, sends small again
```

---

## H. PROTOTYPE PLAN (smallest safe proof)

Isolated package-level prototype — **no production pipeline change**:

1. New module `packages/agent/src/token-harness/` (protocol + pipeline engine) with
   `process()` as a pure function over `HarnessInput`.
2. Built-in modules v0 (all deterministic, CPU, no deps):
   - `protect.v0` — mark system prompt, current user instruction, tool schemas,
     plan-protected matchers, edit-region paths.
   - `dedup.v0` — exact repeated tool-result block collapse to reference + marker.
   - `suppress.v0` — per-tool output budget (default ~1,500 tokens head-preserving,
     omission marker, full text spilled to a local artifact dir under the session).
   - `assemble.v0` — pairing repair + stable-prefix ordering.
   - `validate.v0` — protected assertion + native token recount + report.
3. Fixture harness: `packages/agent/test/token-harness/*` with representative
   captured sessions (long session, huge tool logs, repeated reads, debug loop).
4. Metrics: input/output tokens, ratio, latency, protected-survival boolean,
   failure-visibility (each simulated module failure must surface in report).
5. Optional measurement runner comparing ORIGINAL vs +HARNESS on fixtures — numbers
   reported, never assumed.

Exit criterion for prototype: architecture proven (items 1–10 of section 21 of the
brief), not a compression target.

---

## I. TEST PLAN (acceptance criteria)

Per-test contracts (each names a failure mode):

1. **Protect:** mutating any protected element makes `validate` fail and the harness
   returns the ORIGINAL messages (fail-open) + warning. Regression: a bug that strips
   the current instruction must never reach the wire.
2. **Dedup:** identical tool output resent twice → second occurrence becomes
   reference; `state`/session still has full text (read-back assertion).
3. **Suppress:** tool result > budget → output ≤ budget + marker, head content and
   any ERROR lines retained (assert error lines survive truncation).
4. **Pairing integrity:** every `tool_result` still matches its `tool_call` after
   suppression (structural assertion) — a dropped pair must be caught by validate.
5. **Reduction measured:** fixtures report input/output tokens and ratio; assert
   ratio > 1 on tool-heavy fixtures and ratio == 1 on already-minimal fixtures
   (no noise added).
6. **Latency budget:** pipeline p95 under configured budget on CPU; module exceeding
   `maxLatencyMs` is dropped, request still dispatched (visible in report).
7. **Swap test:** disabling module B and enabling module C changes only their deltas —
   proves plug-and-play (module registry contract).
8. **Fail-open:** force each module to throw → inference still proceeds with prior
   messages; `report.failure` populated; audit counter incremented.
9. **Cache stability:** same session prefix across two consecutive calls → harness
   output for the shared prefix byte-identical (CAPC query-agnostic invariant).
10. **Local exclusion:** ollama/local model classified via catalog → harness bypassed,
    request unchanged.
11. **No-secret leakage:** suppressed/dedup markers never contain redaction keys;
    artifacts written under session dir with same perms as session files.
12. Real-world validation (later): A/B on equivalent PrimePi builds — provider-facing
    input tokens, successful turns before rate-limit, latency, task correctness.
    Claims only after measurement.

Test-clock note: all time-dependent paths take injectable `clock`.

---

## J. RISKS / OPEN QUESTIONS

1. **Cache vs compression interaction** — OMP's current cache emission (breakpoints)
   must be re-audited once `assemble` mutates prefixes; CAPC numbers are from one
   provider model. Mitigation: query-agnostic rule + per-provider cache check in
   validate. **Unknown:** does OMP currently set `cache_control` breakpoints
   explicitly, or rely on implicit caching? Needs verification in adapters.
2. **Semantics of suppression markers across providers** — a marker like
   `[tool output: 294 passed, full text artifact A17]` must not confuse tool-pairing
   validators or models. Validate + fixture evaluation needed.
3. **Interaction with tool-result replay/seen-line guards** — OMP edit guards
   (`edit.enforceSeenLines`, seen-line store) reference tool-result history; harness
   suppression must never suppress content a later guard expects. Mitigation: protect
   stage includes "recent edit-region tool results".
4. **Subagent/advisor/compaction one-shot calls** also flow through the hook — do we
   compress those? Probably yes for tool-blobs, no for one-shot prompts. Open.
5. **Which sessions are fixtures** — need real long-session captures; privacy care
   (fixtures must be sanitized/redacted before use).
6. **LLMLingua-2 CPU feasibility** — unproven on this machine; time-box the spike;
   if p95 > budget, drop to rules-only.
7. **Reduction ratio unknown by design** — report actuals only (section 14 of brief).
8. **Hook ordering vs Wave 1 work** — the settings-stream-fn hook must compose with
   the model-authority work already in flight (failover/turn-recovery changes) — no
   overlap in files, low conflict risk.

---

## RECOMMENDATION

1. **REUSE:** the `createSettingsAwareStreamFn` hook (`session/settings-stream-fn.ts`);
   native `countTokens`/`tokenizer.ts`; artifact spill (`output-meta.ts`); session
   JSONL + `context_edit` pruning (Wave 6); transform-messages pipeline (unchanged,
   runs after the harness); compaction/shake/snapcompact as the fallback layer;
   bounded memory recall; prompt-cache emission in adapters.

2. **ADAPT:** provider-practice mechanics as harness stages — Anthropic/Claude-Code
   style tool-result clearing → `suppress` stage (head-preserving budget + omission
   marker + local artifact); AWS Strands 1,500-token convention as the default budget;
   MemGPT tiering → `select` stage policy; CAPC query-agnostic + r_max floor rules →
   `assemble` stage policy; `prompt-compressor` (npm, MIT) rule set — vendored and
   audited, not depended on; optionally LLMLingua-2 (via TS port) as a bolt-on module
   for cold large blobs only, behind a time-boxed experiment.

3. **REJECT:** LLMLingua v1 and LongLLMLingua as dependencies (Python, latency, and
   query-aware compression actively hostile to prompt caching); Selective Context as a
   dependency; AutoCompressors, ICAE, 500xCompressor (require decoder/soft-prompt/KV
   access — impossible against black-box APIs, GPU-bound); any GPU-dependent or
   Python-process dependency in the hot path.

4. **BUILD NATIVELY (PrimePi's own 80%):** the harness engine (module contract,
   health/estimate/process/validate/fail-open, latency watchdog); `protect`
   (message-structured invariants); `dedup` (fuzzy block dedup + reference collapse);
   `select` (message-tier policy reusing shake/compaction budgets); `suppress`
   (per-tool budgets + artifact write-through); deterministic `compress` (text
   normalization only, no learned model in v1); `assemble` (cache-aware, pairing
   repair); `validate` (protected assertion + token recount + cache-prefix check).
   No production-grade structured compressor exists in TS — this gap is ours.

5. **SMALLEST NEXT PROTOTYPE:** a pure-function pipeline in
   `packages/agent/src/token-harness/` (protocol + engine + five built-in v0 modules:
   protect/dedup/suppress/assemble/validate), fed by captured session fixtures, with
   a metrics runner — no change to the production dispatch path. Wire the hook only
   after the prototype reports survive review.

6. **FILES TOUCHED BY THE PROTOTYPE (first):**
   - `packages/agent/src/token-harness/{index.ts, contract.ts, pipeline.ts, artifacts.ts}`
   - `packages/agent/src/token-harness/modules/{protect.ts,dedup.ts,suppress.ts,assemble.ts,validate.ts}`
   - `packages/agent/test/token-harness/*.test.ts` (fixtures + contracts above)
   - config keys only via `packages/coding-agent/src/session/settings.ts` when the
     integration step arrives (config-file/env — **no settings UI**)
   - production hook (second step): `packages/coding-agent/src/session/settings-stream-fn.ts`
   - optional enforcement net (later): `packages/ai/src/stream.ts`

7. **WHY:** the hook at `settings-stream-fn` is the narrowest boundary that sees every
   coding-agent online request with full session/settings/model context while leaving
   pi-ai's provider transforms and all adapters untouched — one seam, full provider
   coverage, zero risk to local inference and zero UI work. The engine is pure and
   package-local, so it can be tested and measured before any production request path
   changes, and module swapping (the plug-and-play requirement) is a registry
   operation rather than an architectural change.
