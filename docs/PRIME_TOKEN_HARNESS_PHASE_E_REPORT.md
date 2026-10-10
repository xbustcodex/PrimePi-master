# PRIME TOKEN HARNESS — Phase E: Controlled Active-Mode A/B Trial Report

Status: **fixture-level evidence gathered**; **interactive multi-turn verification debt outstanding** (see PRIME_TOKEN_HARNESS_PRODUCTION_REPORT.md §E.9).

## Evidence summary

### Fixture-level A/B comparison (already documented in committed reports)

The token-harness benchmark suite produces the following reduction ratios (fixture outputs, deterministic). These counts are the **same** as already documented in:

- `docs/PRIME_TOKEN_HARNESS_BENCHMARK.md:14`
- `docs/PRIME_TOKEN_HARNESS_PRODUCTION_REPORT.md §E.4`

|| baseline → optimized || reduction || latency ||
||----------------------||----------||--------||
|| long-session (mixed) || 19,357 → 3,959 || 79.5% || 1.0 ms ||
|| repeated CI output    || 9,662 → 4,293 || 55.6% || 0.3 ms ||
|| huge JSON dumps       || 325,349 → 131,342 || 59.6% || 2.3 ms ||
|| debug-loop            || 6,521 → 3,461 || 46.9% || 0.2 ms ||
|| minimal session       || 6 → 6 || 0.0% || 0.2 ms ||

### Live shadow-mode probe (already documented)

A single real dispatch-shadow probe was recorded via
`omp -p ... --model openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free --config <shadow overlay>`:
successful assistant reply with 0% shadow-mode reduction on a single-turn print.
Details in `docs/PRIME_TOKEN_HARNESS_PRODUCTION_REPORT.md §E.0-E.4` and §E.10.

## What Phase E did NOT change

- `tokenHarness.enabled` remains `false`; shadow-only is still the active instruction.
- Model browser, Settings UX, theme system, command registry, memory engines, LSP, session storage format, all existing integrated behavior preserved intact.
- Wave 1 model-authority improvements not mixed with harness sets.

## Outstanding verification debt (blocks ENABLE)

See `docs/PRIME_TOKEN_HARNESS_PRODUCTION_REPORT.md §E.9` for the complete list:

1. Live token-harness accumulation over real multi-turn sessions with `shadowEnabled: true`.
2. Tokenizer estimate vs provider-billed input tokens (one model/provider pair).
3. Prompt-cache hit-rate with active mode.
4. Agent-task-completion A/B on representative coding tasks.
5. Interaction with edit seen-line guards / tool-result replay on real history.
6. Module interruption semantics (detect-only, only).

## Recommendation

Architecture is verified safe; `tokenHarness.enabled` should remain `false` until the **interactive** verification debt above is satisfied by the owner.