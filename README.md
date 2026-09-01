# Frontend Engineering Memory

Local, evidence-backed technical memory for a fleet of Next.js repositories.

Frontend Engineering Memory indexes repository structure and behavior into SQLite, FTS5, and `sqlite-vec`, then exposes a small read-only MCP surface to Codex, Claude, Cursor, and other MCP clients. It is designed to answer repository questions with bounded, source-linked context instead of loading an entire codebase into the model.

## Highlights

- App Router, Pages Router, and hybrid Next.js projects
- Exact route inventory plus rendering, middleware, cache, SEO, and dependency behavior
- Server Functions, cache tags/invalidation, validation schemas, authorization, and analytics events
- Symbol-level flow, impact, verification, and change graphs
- `next.config` rules and Next.js special-file conventions
- Cross-repository package dependency links
- Fleet-wide route discovery with Turkish/Unicode aliases (`/hakkımızda` → `/hakkimizda`)
- Incremental Git sync, immutable indexed-SHA snapshots, and behavior diff
- Local multilingual embeddings with repository-filtered vector search
- Evidence, confidence, freshness, uncertainty, and targeted source fallback in every context pack
- Retrieval telemetry, answer feedback, security audit, and measured rollout gates

Normal indexing and retrieval make no external LLM request. The default embedding model runs locally through Transformers.js.

## Requirements

- Node.js 20+
- pnpm 10+
- Git
- Local access to the Next.js repositories being indexed

## Quick start

```bash
pnpm install
cp .env.example .env
cp config/repositories.example.json config/repositories.json
```

Configure one or more repositories:

```json
{
  "repositories": [
    {
      "name": "company.web.next",
      "path": "/absolute/path/to/company.web.next",
      "mainBranch": "main",
      "managedCheckout": false,
      "queryAliases": {
        "kullanıcının söylediği ürün terimi": ["SourceSymbol", "api-term"]
      }
    }
  ]
}
```

Developer working trees should use `managedCheckout:false`. A service-owned clean clone may use `managedCheckout:true` with a configured remote. Dirty working trees are refused; the indexer never resets a developer checkout.

`queryAliases` is optional. Each key and its values form a symmetric vocabulary group, allowing Turkish/product terminology to find differently named source symbols without changing the embedding model. Keep groups repository-specific and evidence-oriented; they are applied only when the query mentions a term in that group.

Create the first index and verify it:

```bash
pnpm memory full company.web.next
pnpm memory embedding-status
pnpm memory quality company.web.next
pnpm memory security-audit company.web.next
```

The default database is created at `data/engineering-memory.sqlite`. The first vector operation downloads the pinned local `multilingual-e5-small-v1` profile.

## MCP

The server exposes three read-only tools:

| Tool | Purpose |
| --- | --- |
| `memory_repository` | Repository profiles and cross-repository package links |
| `memory_route` | Route inventory, fleet-wide route lookup, behavior, evidence, and dependencies |
| `memory_context` | Bounded lookup, flow, impact, debug, implementation, verification, change-review, temporal, and decision context |

Build once for stdio clients:

```bash
pnpm build
pnpm start:mcp
```

Example client files are provided for:

- Codex: `config/codex-mcp.example.toml`
- Claude: `config/claude-mcp.example.json`
- Cursor over HTTP: `config/cursor-mcp.example.json`

For HTTP MCP and the local inspection UI:

```bash
pnpm serve
```

- MCP: `http://127.0.0.1:4317/mcp`
- UI: `http://127.0.0.1:4317/`
- Health: `http://127.0.0.1:4317/health`

Copy the policy block from `config/AGENTS.memory.example.md` into the target repository's `AGENTS.md` or equivalent agent instructions. See [Agent integrations](docs/INTEGRATIONS.md) for complete setup guidance.

## Daily operation

After changes reach the indexed branch:

```bash
pnpm memory sync-all
```

`sync-all` isolates failures by repository. A clean repository with no new commit returns `NOOP`; changed repositories receive route reconciliation, incremental analysis, memory invalidation, and vector updates.

Useful operational commands:

```bash
pnpm memory status
pnpm memory routes company.web.next
pnpm memory route-dependencies company.web.next --route=/account
pnpm memory search "where is session authorization checked?" --repo=company.web.next
pnpm memory freshness company.web.next
pnpm memory reconcile-all
pnpm memory rollout-status
```

See [Operations](docs/OPERATIONS.md) before onboarding a larger fleet or enabling managed checkouts.

## What is indexed

The engine stores focused facts and relations rather than generic file summaries:

- repository/package/runtime profile
- routes, layouts, middleware matchers, redirects, and not-found behavior
- static, dynamic, ISR, RSC, and client-boundary signals
- fetch/Axios/ky/custom-client targets and configuration-key usage
- Server Functions and observed client/server calls
- cache scope, lifetime, tags, paths, and invalidation
- schema fields and observed FormData/JSON payloads
- authentication and authorization signals
- analytics event names, transports, and payload keys
- `next.config` settings, rewrites, redirects, and headers
- loading/error/not-found/metadata special files
- state, security, performance, error, and technical-debt signals
- symbol, component, API, config, test, and repository dependency graphs

Every active memory points to repository-relative evidence and an indexed commit. Full source files, generated output, lockfile contents, secrets, and repetitive import summaries are intentionally not copied into the vector index.

## Retrieval model

Queries are planned across three complementary stores:

1. Structured SQL for exact inventory, repository identity, and routes.
2. FTS5 for precise technical identifiers.
3. Local vectors for differently worded conceptual questions.

Task-aware graph traversal produces specialized packs for flows, impact, implementation, debugging, verification, and change review. Each pack contains an `answerContract` separating facts, derived relations, inference, uncertainty, missing evidence, and source fallback.

The default embedding profile is pinned by model revision, dimension, dtype, and query/passage prefixes. Larger included profiles should only be selected after an evaluation demonstrates a real gain. See [Embedding model](docs/EMBEDDINGS.md).

## Temporal and decision memory

Successful indexing stores an immutable behavior snapshot for the indexed SHA. Use `atSha` for point-in-time context and `atSha` plus `compareToSha` for behavior diff.

Architectural rationale is not inferred from source code. Approved decisions are stored separately:

```bash
pnpm memory decision-add company.web.next --file=config/decision.example.json
pnpm memory decisions company.web.next
```

Only approved ADR, PR, issue, or human provenance may answer “why was this chosen?” questions.

## Quality and evaluation

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm memory evaluate
pnpm memory context-eval
pnpm memory security-audit
```

`evaluate` measures retrieval Recall@K. `context-eval` executes task-level MCP plans and measures required-evidence recall and context savings against source reads. Add real engineering questions as the fleet grows; do not expand extraction or change embeddings without a measured miss.

The current implementation passes 156 tests. The latest two-repository validation produced 0.9231 mean evidence recall, 15/15 clean cases, 100% active vector/evidence/commit coverage, and an open rollout gate.

The evaluation contract and 50-question golden catalog live in [Evaluation](docs/EVALUATION.md).

## Security and privacy

- Environment key names may be indexed; environment values are not.
- The SQLite database, local repository registry, `.env`, model cache, and evaluation runs are ignored by Git.
- Telemetry stores query shape/hash by default, not question text or retrieved fact bodies.
- MCP tools are read-only.
- The HTTP server binds to `127.0.0.1` by default and has no authentication.

Do not expose `MEMORY_HOST=0.0.0.0` without an authenticated reverse proxy. The same server also provides indexing endpoints.

## Deliberate limits

This is conservative static analysis, not a TypeScript compiler or runtime tracer. It does not prove that every code path executes in production. Unknown or insufficient evidence is surfaced through the answer contract.

The current scope intentionally excludes:

- OpenAPI/GraphQL schema ingestion
- monorepo workspace modeling
- instrumentation and runtime/build-manifest evidence
- external incoming-consumer discovery

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agent integrations](docs/INTEGRATIONS.md)
- [Operations](docs/OPERATIONS.md)
- [Evaluation](docs/EVALUATION.md)
- [Embedding model](docs/EMBEDDINGS.md)

## Development status

The repository is production-ready for controlled Next.js fleet use. Expansion is gated in `2 → 4 → 8 → 16` waves by freshness, security, evidence coverage, duplication, latency, and evaluation quality.

This package remains marked `private` because it is currently distributed as source/service infrastructure rather than as a public npm package.
