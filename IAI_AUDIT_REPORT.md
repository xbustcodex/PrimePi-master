# IAI Brain Engine Audit Report

## Architecture Overview

The IAI Personal Memory Engine is a sophisticated local-first memory system with the following key characteristics:

### Core Components

1. **Memory Banks (SQLite)**: Multiple isolated banks (working, episodic, fact) with per-bank encryption
2. **Embedding Generation**: Native (fastembed) or HTTP provider with configurable dimensions
3. **MCP Interface**: Full suite of 15+ tools exposed via JSON-RPC over Unix domain sockets
4. **Daemon**: Long-running process with background consolidation, sleep cycles, watchdog
5. **Crypto**: PBKDF2 (600k iterations) + AES-GCM encryption with per-user keys
7. **Desktop App**: Tauri-based UI for visualization

### MCP Tools (15+ verified in installed version)

| Tool | Purpose | Read/Write |
|------|---------|------------|
| memory_recall | Semantic recall | Read |
| memory_search | Hybrid lexical+semantic search | Read |
| memory_recall_structural | TEM structural recall | Read |
| memory_reinforce | Reinforce memory importance | Write |
| memory_contradict | Detect contradictions | Write |
| memory_capture | Capture conversation turns | Write |
| memory_consolidate | Consolidate memories | Write |
| memory_temporal_recall | Time-based recall | Read |
| profile_get_set | User profile management | Read/Write |
| topology | Graph topology visualization | Read |
| schema_list | Schema introspection | Read |
| events_query | Event timeline queries | Read |
| episodes_recent | Recent episode recall | Read |
| curiosity_pending | Curiosity queue | Read |
| brain_view | Dashboard data | Read |

### Embedding Providers
- **Native (default)**: Local fastembed with ONNX models, no external dependencies
- **HTTP**: External service via `IAI_MCP_EMBED_URL`, requires `IAI_MCP_EMBED_DIM`, `IAI_MCP_EMBED_MODEL_ID`, `IAI_MCP_EMBED_TIMEOUT_SEC`
- Configuration: `IAI_MCP_EMBED_PROVIDER` (native|http), `IAI_MCP_EMBED_QUANTIZE`, `IAI_MCP_EMBED_DATE`

### Networking
- **Local only**: Unix domain sockets (~/.iai-mcp/.daemon.sock) or Windows named pipes
- **No native TCP/HTTP server** for remote access
- **Socket server**: JSON-RPC over local IPC with foreground/background priority

### Windows Compatibility
- ✅ Native Windows support via named pipes
- ✅ Rust native module compiled for Windows (iai_mcp_native.cp312-win_amd64.pyd)
- ✅ Tauri desktop application
- ✅ File locking compatible

### Encryption
- PBKDF2 (600,000 iterations) + AES-256-GCM
- Key derived from passphrase + user_id salt
- Key stored at ~/.iai-mcp/.crypto.key

---

## PrimePi Memory System Analysis

### Existing Backends
| Backend | Description | Type |
|---------|-------------|------|
| off | No memory | Disabled |
| local | Local rollout summarization | Local file |
| hindsight | Remote vector service | HTTP/REST |
| mnemopi | Local SQLite + embeddings | Local SQLite |
| sharpshooter | Project decision files | Local files |

### Memory Backend Interface
PrimePi defines a clean `MemoryBackend` interface with:
- `start()`, `buildDeveloperInstructions()`, `clear()`, `enqueue()`
- `status()`, `search()`, `save()`, `stats()`, `diagnose()`, `queuePreview()`
- `beforeAgentStartPrompt()`, `preCompactionContext()`, `applySettings()`

### Learning System (Auto-Learn)
- Post-stop nudge to capture lessons
- Uses `capture` function to inject lessons
- Integrates with `manage_skill` and `learn` tools
- Currently writes to active memory backend

### AGENTS.md Protection
- No explicit protection currently - learning can write to any backend
- Need to ensure IAI backend doesn't write to AGENTS.md

---

## Gap Analysis

| Capability | IAI | PrimePi | Gap |
|------------|-----|---------|-----|
| Local semantic recall | ✅ | ✅ (mnemopi) | None |
| Project isolation | ✅ (banks) | ✅ (scoping) | None |
| Remote memory | ❌ (local only) | ✅ (hindsight) | **Major** |
| TCP networking | ❌ (Unix sockets only) | N/A | **Major** |
| HTTP embedding | ✅ | N/A | None |
| Encryption | ✅ | Partial | None |
| Desktop UI | ✅ | ❌ | None |
| MCP protocol | ✅ | ✅ (own MCP) | Compatible |
| Auto-learn integration | ✅ (capture) | ✅ | Compatible |
| Project trust/banking | ✅ (banks) | ✅ (scoping) | Compatible |
| Structured learning types | ✅ (working/episodic/fact) | Partial | **Minor** |
| Contradiction detection | ✅ | ❌ | **IAI advantage** |
| Memory reinforcement | ✅ | ❌ | **IAI advantage** |
| Structural recall | ✅ (TEM) | ❌ | **IAI advantage** |

---

## Integration Strategy

### Phase 1: IAI Backend Adapter (Week 1)
1. Create `iai-backend.ts` implementing `MemoryBackend` interface
2. Add "iai" to `cfgMemoryBackend` enum
3. Implement session hooks: start, beforeAgentStartPrompt, enqueue
3. Use PrimePi's MCP client to connect to IAI daemon via Unix sockets
4. Handle project/bank scoping via PrimePi's project identity

### Phase 2: Session Integration (Week 1-2)
1. Session-start recall via `memory_recall` or `session_start_payload`
2. Session-end retain via `memory_capture` / `session_exit`
3. Auto-learn redirect to `memory_capture` with structured metadata
4. Implement search/save via `memory_search`/`memory_capture`

### Phase 3: Linux Long-Term Memory (Week 2-3)
1. Build TCP/WS bridge on Linux (port 8080/8443)
2. Auth: mTLS or token-based
3. Implement archival lifecycle: ACTIVE → PENDING_ARCHIVE → ARCHIVED
3. Offline queue on Windows with durable write-ahead log
4. Conflict detection via vector timestamps

### Phase 4: AGENTS.md Protection (Week 2)
1. Ensure IAI backend never writes to AGENTS.md
2. Structured learning metadata in IAI (type, verification, project)
3. Explicit promotion workflow for instructions

### Phase 5: Testing & Verification (Week 3)
1. Local brain integration tests
2. Learning capture/recall tests
3. Linux archival/recovery tests (simulated if hardware unavailable)
4. Restart/recovery tests
5. Multi-agent isolation tests

---

## Recommended Implementation Files

### New Files
1. `packages/coding-agent/src/memory-backend/iai-backend.ts` - IAI backend implementation
2. `packages/coding-agent/src/memory-backend/iai-client.ts` - MCP client wrapper
3. `packages/coding-agent/src/memory-backend/iai-types.ts` - IAI-specific types
4. `packages/coding-agent/src/memory-backend/iai-network-bridge.ts` - Linux bridge
5. `packages/coding-agent/src/memory-backend/iai-archival.ts` - Archival lifecycle

### Modified Files
1. `packages/coding-agent/src/memory-backend/settings.ts` - Add "iai" to enum
2. `packages/coding-agent/src/memory-backend/resolve.ts` - Register IAI backend
3. `packages/coding-agent/src/memory-backend/index.ts` - Export IAI backend
4. `packages/coding-agent/src/autolearn/controller.ts` - Redirect capture to IAI
5. `packages/coding-agent/src/memory-backend/types.ts` - Add IAI-specific types if needed

### Linux Deployment (Separate)
1. `deploy/iai-linux-bridge.service` - systemd service
2. `deploy/iai-bridge.config.toml` - Bridge configuration
3. `deploy/deploy.sh` - Deployment script
4. `deploy/backup.sh` - Backup script

---

## Immediate Next Steps

1. **Create IAI backend adapter** implementing `MemoryBackend` interface
2. **Register "iai" backend** in PrimePi settings
3. **Test local integration** with existing IAI daemon
4. **Implement auto-learn redirect** to IAI capture
5. **Design network bridge** for Linux long-term memory