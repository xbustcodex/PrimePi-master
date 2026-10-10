# Wave 2A: Existing Architecture & Identified Gaps

## 1. Tool Approval Resolver

**OMP** (`packages/coding-agent/src/tools/approval.ts`):
- `resolveApproval(tool, args, mode, userConfig)` — single authoritative function
- Three modes: `always-ask` (auto-approve read), `write` (auto-approve read/write), `yolo` (auto-approve all)
- Per-tool policies: `tools.approval.<tool>: allow|deny|prompt` (record type)
- Tier system: `read` (0) < `write` (1) < `exec` (2)
- User deny is absolute; yolo doesn't override user deny
- Legacy name fallback for renamed MCP tools

**PrimePi** (`packages/coding-agent/src/core/settings-descriptors.ts`):
- Identical settings: `toolApprovalMode` (enum), `toolApprovalPolicies` (record)
- Same resolution order: tool decision → user policy → mode ceiling
- Difference: PrimePi docs state "deny is unconditional: no mode overrides it" — OMP implements this correctly

**Gap**: None significant. OMP's implementation is complete and matches PrimePi's design.

---

## 2. Bash & Shell Execution Tools

**OMP** (`packages/coding-agent/src/tools/bash.ts`):
- Bash tool approval function evaluates:
  - User-configured patterns (`bash.patterns` array of `{match, approval}`)
  - Critical patterns (`CRITICAL_BASH_PATTERNS` — rm -rf /, fork bombs, disk writes, etc.)
  - Compound command segmentation via `shell-tokenize.ts`
- `cfgBashAllowCompoundCommands` controls segment-level evaluation
- When enabled: checks each `&&` segment; unmatched segments fall back to tool/mode
- `hasBashApprovalShellControl` detects shell metacharacters and reinterpretation risks

**PrimePi** (`packages/coding-agent/src/core/shell/approval-patterns.ts`):
- Simpler glob patterns (only `*` wildcard, everything else escaped)
- Anchored matching (entire command must match)
- `chainOnly` option: rule applies only to complete chain, not per segment
- `firstMatchingRule`: deny always wins regardless of order; allow only first match
- Same compound command segmentation logic

**Gaps in OMP**:
1. Missing `chainOnly` pattern option — PrimePi allows rules that only match complete chains
2. OMP's pattern matching uses regex-style (`bashApprovalPatternToRegExp`); PrimePi uses safer glob-to-regex
3. OMP's pattern rule order: "segment rules keep their ordered first-match semantics... restrictions matching only the complete chain are aggregated separately" — PrimePi's deny-always-wins is safer
4. OMP allows `allow` rules to match segments when `compoundSegments` exist; PrimePi's `allow` requires full chain match and no shell control chars

---

## 3. File Writing & Editing Permissions

**Both**: Use tier system. `write`/`edit`/`ast_edit` declare `approval = "write"` or function returning tier based on args. File operations go through `InternalUrlFilesystem` with tier-bounded permissions.

**Gap**: None significant.

---

## 4. Project Trust & Workspace Boundaries

**OMP** (`packages/coding-agent/src/extensibility/extensions/types.ts`):
- `isProjectTrusted(): boolean` — **always returns `true`**
- Comment: "OMP has no equivalent per-directory trust gate... OMP already trusts project-local inputs by default"
- Project-local configs (`.omp/extensions`, `.omp/config.yml`, skills) load unconditionally

**PrimePi** (`packages/coding-agent/src/core/trust-manager.ts`, `project-trust.ts`):
- `ProjectTrustStore` with persisted `trust.json` (file-locked, sorted keys)
- `hasTrustRequiringProjectResources(cwd)` — checks for `.pi/settings.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`
- UI prompt with options: Trust, Trust parent, Trust (session only), Don't trust, Don't trust (session only)
- `defaultProjectTrust` setting: `ask` | `always` | `never` (global only)
- Extension integration via `emitProjectTrustEvent` (extensions can auto-decide)
- `resolveProjectTrusted` returns boolean, persists decision when `remember: true`

**Major Gap**: OMP completely lacks project trust gating. Project-local configs load without user consent.

---

## 5. Delegated Agent Tool Permissions

**OMP** (`packages/coding-agent/src/task/executor.ts`, `sdk.ts`):
- Subagents created via `createAgentSession` inherit parent's `Settings` object
- `CreateAgentSessionOptions` includes `settings?: Settings` — parent passes its settings
- Subagent gets own `AgentSession` with `taskDepth`, `parentAgentId`, restricted tools via `restrictToolNames`
- No explicit permission delegation — subagent gets all parent's approval policies by default
- `cfgTaskMaxRecursionDepth`, `cfgTaskMaxConcurrency`, `cfgTaskSoftRequestBudget` limit resource usage but not permissions

**PrimePi**:
- Same inheritance model
- Additional isolation settings: `task.isolation.enabled`, `task.isolation.merge`, `task.isolation.commits`, `task.isolation.apply`
- Subagent budget controls but no explicit permission restriction beyond `restrictToolNames`

**Gap**: Neither system has explicit permission delegation. Subagents inherit full parent approval policies. PrimePi's isolation settings are about git/workspace isolation, not permission boundaries.

---

## 6. Approval Prompts & User Decisions

**OMP**: `formatApprovalPrompt` in `approval.ts` shows tool name, origin (MCP), reason, and tool-specific details. `prompt` from `@oh-my-pi/pi-utils` handles UI.

**PrimePi**: Similar prompt formatting via `formatProjectTrustPrompt` for trust decisions.

**Gap**: None significant.

---

## 7. Audit & Execution Logging

**OMP**: `tools.intentTracing` (default on) — asks agent to describe intent before each tool call. `tools.abortOnFabricatedResult` stops on hallucinated results. Auto QA (`dev.autoqa`) reports tool issues.

**PrimePi**: Same settings declared in `settings-descriptors.ts`.

**Gap**: None significant.

---

## Summary of Gaps to Address in Wave 2

| Area | Gap | Priority |
|------|-----|----------|
| Project Trust | **Complete absence** — OMP trusts all projects unconditionally | **HIGH** |
| Compound Commands | Missing `chainOnly` pattern option; deny doesn't always win across segments | **HIGH** |
| Pattern Matching | OMP uses regex-style; PrimePi uses safer anchored glob | **MEDIUM** |
| Delegated Permissions | No explicit permission delegation; subagents inherit full parent perms | **MEDIUM** |
| Windows Compatibility | PrimePi trust store uses `proper-lockfile`; need Windows-compatible locking | **MEDIUM** |

---

## Smallest Compatible Integration Points

1. **Project Trust**: Add `ProjectTrustStore` and `resolveProjectTrusted` to OMP's `config` domain; gate extension/config loading in `agent-session.ts` and `sdk.ts`
2. **Compound Commands**: Add `chainOnly` to `BashApprovalPatternRule` and update `bash.ts` approval logic to use deny-always-wins semantics
3. **Pattern Matching**: Replace `bashApprovalPatternToRegExp` with PrimePi's `patternToRegExp` (glob-only)
4. **Delegated Permissions**: Add `delegatedApprovalPolicy` to `CreateAgentSessionOptions` for subagents

---

## Real Execution Path Trace

```
Agent tool call (e.g., bash "rm -rf /")
    → Tool.approval(args) returns tier + policy (bash.ts:504-588)
    → resolveApproval(tool, args, mode, userPolicies) → ResolvedApproval (approval.ts:203)
    → requiresApproval() throws if deny, returns {required: true} if prompt
    → If prompt: UI shows formatApprovalPrompt → user allows/denies
    → If allow: execute() runs executeBash() with tier-bounded filesystem
    → Result returned; intent traced if tools.intentTracing enabled
```

This path is already enforced in OMP. Wave 2 must ensure no bypasses exist and strengthen the weak points identified above.