# Roadmap

## Phase 1 — implemented (P0 correctness)

- Atomic full/incremental indexing and Git snapshot verification
- Temporal route/memory history and source evidence
- App/Pages/hybrid routes, import/layout behavior and intercepting routes
- SQLite, FTS5, local embeddings and sqlite-vec

## Phase 2 — implemented (P1 acceptance and retrieval)

- Structured route behavior and route→dependency edges
- Middleware matcher, API/config/internal-package analysis
- Change classifier and run-level `changed_since` audit
- SQL + FTS + filtered vector orchestration
- Provider abstractions and source-hash memory/vector reuse

## Phase 3 — implemented (P2 agent integration and quality)

- MCP 2.0 stdio server compatible with current and legacy clients
- Read-only repository/route/dependency/search/change/explain/quality tools
- Token-bounded agent context with source evidence
- Optional AI extractor with confidence, exact quote and line-range gates
- AI producer/quality metadata and source-hash invalidation
- Scheduled hash-aware reconciliation
- Evidence/vector coverage metrics and retrieval Recall@K evaluation
- Custom Next.js `distDir` exclusion to remove generated-output retrieval noise
- Codex/Claude configuration and memory-first instruction templates

## Next — production hardening after live agent usage

- Grow the retrieval evaluation set from real Codex/Claude questions
- Add per-tool latency, hit-rate and context-token telemetry
- Historical point-in-time queries by SHA/time
- Wider cache/dependency impact graph where pilot misses justify it
- Remote authenticated Streamable HTTP MCP only if local stdio is no longer sufficient
- Controlled multi-repository rollout after pilot precision is accepted
