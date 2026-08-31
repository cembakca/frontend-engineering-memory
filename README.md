# Frontend Engineering Memory

A central, living technical memory for multiple Next.js repositories.

It does **not** generate repository Markdown documentation. It stores current technical facts in SQLite and refreshes them after changes on `main`/`master`.

## Project documents

- [Product and technical plan](docs/ENGINEERING_MEMORY_PLAN.md)
- [Current plan gap analysis](docs/PLAN_GAP_ANALYSIS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Codex/Claude token-economic usage](docs/AI_USAGE.md)
- [Repository Context Engine TODO](docs/REPOSITORY_CONTEXT_ENGINE_TODO.md)
- [Repository Context Engine evaluation contract](docs/REPOSITORY_CONTEXT_ENGINE_EVALUATION.md)
- [RCE-002 A/B baseline results](docs/REPOSITORY_CONTEXT_ENGINE_BASELINE.md)
- [RCE-002 live A/B run-book](docs/RCE-002-AB-RUNBOOK.md)
- [RCE-003 retrieval miss taxonomy](docs/REPOSITORY_CONTEXT_ENGINE_MISS_TAXONOMY.md)
- [RCE-004 context economy contract](docs/REPOSITORY_CONTEXT_ENGINE_ECONOMY.md)
- [RCE-005 entity/evidence normalization design](docs/REPOSITORY_CONTEXT_ENGINE_NORMALIZATION.md)
- [RCE-006 memory acceptance policy](docs/REPOSITORY_CONTEXT_ENGINE_ACCEPTANCE.md)
- [RCE-007 fact confidence contract](docs/REPOSITORY_CONTEXT_ENGINE_CONFIDENCE.md)
- [RCE-008 analyzer semantic correctness pack](docs/REPOSITORY_CONTEXT_ENGINE_SEMANTIC_CORRECTNESS.md)
- [RCE-009 graph ontology](docs/REPOSITORY_CONTEXT_ENGINE_GRAPH_ONTOLOGY.md)
- [RCE-010 symbol/component graph extraction](docs/REPOSITORY_CONTEXT_ENGINE_SYMBOL_GRAPH.md)
- [RCE-011 flow traversal](docs/REPOSITORY_CONTEXT_ENGINE_FLOW_TRAVERSAL.md)
- [RCE-012 change-impact traversal](docs/REPOSITORY_CONTEXT_ENGINE_CHANGE_IMPACT.md)
- [RCE-013 test/verification graph](docs/REPOSITORY_CONTEXT_ENGINE_TEST_VERIFICATION.md)
- [RCE-014 task intent model](docs/REPOSITORY_CONTEXT_ENGINE_TASK_INTENT.md)
- [RCE-015 query planning](docs/REPOSITORY_CONTEXT_ENGINE_QUERY_PLAN.md)
- [RCE-016 canonical dedupe and ranking](docs/REPOSITORY_CONTEXT_ENGINE_RANKING.md)
- [RCE-017 typed context-pack schemas](docs/REPOSITORY_CONTEXT_ENGINE_CONTEXT_PACKS.md)
- [RCE-018 answer contract](docs/REPOSITORY_CONTEXT_ENGINE_ANSWER_CONTRACT.md)
- [RCE-019 simplified MCP surface](docs/REPOSITORY_CONTEXT_ENGINE_MCP_SURFACE.md)
- [RCE-020 behavior diff](docs/REPOSITORY_CONTEXT_ENGINE_BEHAVIOR_DIFF.md)
- [RCE-021 point-in-time context](docs/REPOSITORY_CONTEXT_ENGINE_POINT_IN_TIME.md)
- [RCE-022 decision provenance](docs/REPOSITORY_CONTEXT_ENGINE_DECISION_PROVENANCE.md)
- [RCE-023 memory ownership boundary](docs/REPOSITORY_CONTEXT_ENGINE_MEMORY_OWNERSHIP.md)
- [RCE-024 retrieval telemetry](docs/REPOSITORY_CONTEXT_ENGINE_TELEMETRY.md)
- [RCE-025 answer feedback loop](docs/REPOSITORY_CONTEXT_ENGINE_FEEDBACK.md)
- [RCE-026 freshness SLO](docs/REPOSITORY_CONTEXT_ENGINE_FRESHNESS.md)
- [RCE-027 security and data governance](docs/REPOSITORY_CONTEXT_ENGINE_GOVERNANCE.md)
- [RCE-028 second pilot acceptance gate](docs/REPOSITORY_CONTEXT_ENGINE_ROLLOUT_GATE.md)
- [RCE-029 controlled multi-repository rollout](docs/REPOSITORY_CONTEXT_ENGINE_ROLLOUT.md)
- [Holistic implementation pass results](docs/REPOSITORY_CONTEXT_ENGINE_IMPLEMENTATION_PASS.md)

## What is implemented

- Repository registry for many Next.js repositories
- Full first index
- Incremental Git update using `last_indexed_sha -> HEAD`
- Full route reconciliation on **every** sync
- App Router + Pages Router + hybrid route discovery
- Dynamic/catch-all route discovery
- Route-level rendering signals (SSR, SSG, ISR, dynamic SSR, RSC, CSR heuristics)
- Route server/client boundaries, backend/data sources, cache and SEO metadata
- Middleware/proxy matcher evaluation per route
- AST-backed fetch/Axios/ky/GraphQL/custom-client and env dependency discovery
- Structured route-to-dependency relationships with source symbol/line
- Change classifier and import/layout/middleware/metadata impact tracking
- Source-backed memories for:
  - rendering (`cookies()`, `headers()`, `no-store`, etc.)
  - API/fetch calls
  - cache/revalidate
  - authentication/session signals
  - middleware
  - SEO metadata
  - analytics
  - TanStack/React Query
  - internal packages / Design System
  - configuration keys
  - TODO/FIXME technical debt
- Important npm/internal dependency inventory
- Run-level memory change audit and `changed_since`
- Source-hash-aware memory/embedding reuse
- SQLite + FTS5 exact search
- Local embeddings with `@huggingface/transformers`
- Repository/type-filtered `sqlite-vec` semantic vector search
- Query-understood SQL + FTS + vector retrieval
- `EmbeddingProvider` and `VectorStore` abstractions
- HTTP API for CI/agent integration
- Token-bounded read-only MCP server for Codex and Claude
- Machine-readable answer contract for facts, derived relations, inference and uncertainty
- Indexed-SHA snapshots, semantic behavior diff and point-in-time context
- Human-approved decision provenance with explicit supersession
- Evidence-gated optional AI business-memory extraction
- Scheduled hash-aware reconciliation
- Memory/vector coverage metrics and retrieval Recall@K evaluation
- Automatic exclusion of custom Next.js `distDir` build output

## Explicitly out of scope in this version

Per the current product scope, this version does not model:

- Feature Flag / A-B Testing
- Observability
- Incoming Consumers
- Cross-Repository analysis

The database is central; no `repository-technical-memory.md` is produced in target repositories.

## Requirements

- Node.js 20+
- Git
- Target repositories available on the filesystem

The first semantic indexing/search downloads the pinned local embedding profile (`multilingual-e5-small-v1`) through Transformers.js. The profile fixes the model revision, 384-vector dimension, q8 dtype and E5 query/passage prefixes as one reproducible contract. Set `MEMORY_EMBEDDINGS_ENABLED=0` if you want deterministic + FTS indexing only.

## Setup

```bash
pnpm install
cp .env.example .env
```

`.env` is loaded automatically. Explicit process environment variables take precedence. Relative database/registry paths are resolved from this memory project, so MCP clients may launch it from another working directory safely.

Edit `config/repositories.json`:

```json
{
  "repositories": [
    {
      "name": "hangikredi.deposit.fe.next",
      "path": "/Users/you/work/squads/hangikredi.deposit.fe.next",
      "mainBranch": "main",
      "managedCheckout": false
    }
  ]
}
```


### Managed checkout for a central service

If the memory service owns a dedicated clone, enable:

```json
{
  "name": "hangikredi.deposit.fe.next",
  "path": "/srv/frontend-memory/repos/hangikredi.deposit.fe.next",
  "mainBranch": "main",
  "managedCheckout": true,
  "remote": "origin"
}
```

On sync the service performs `fetch` and resets that **dedicated clean checkout** to `origin/main` before comparing SHA values. It refuses to refresh a dirty checkout. Never enable this on a developer working copy.

## First index

```bash
npm run memory -- full hangikredi.deposit.fe.next
```

For a fleet, validate one repository first and then run the bounded batch commands:

```bash
pnpm memory full hangikredi.deposit.fe.next
pnpm memory full-all
pnpm memory embedding-status
pnpm memory rollout-status
```

`full-all`, `sync-all` and `reconcile-all` isolate failures per repository. Add repositories in the configured 2 → 4 → 8 → 16 rollout waves; do not jump directly from two repositories to sixteen. The complete onboarding and rollback sequence is in [`docs/NEXTJS_FLEET_RUNBOOK.md`](docs/NEXTJS_FLEET_RUNBOOK.md).

When an embedding profile changes, stored vectors are isolated in a fingerprinted table. Rebuild them explicitly after selecting the profile:

```bash
pnpm memory vectors                 # all repositories
pnpm memory vectors <repository>    # one repository
pnpm memory embedding-status
```

The measured model decision and larger profiles retained for future A/B runs are documented in [`docs/EMBEDDING_MODEL_EVALUATION.md`](docs/EMBEDDING_MODEL_EVALUATION.md).

The DB is created at:

```text
data/engineering-memory.sqlite
```

## After merge to main

Once CI/local checkout is on the new main commit:

```bash
npm run memory -- sync hangikredi.deposit.fe.next
```

Flow:

```text
last indexed SHA
      |
      v
git diff old..HEAD
      |
      +----> full route rescan (always)
      |
      +----> changed source classification / memory invalidation
      |
      +----> re-analyze only changed source files
      |
      +----> re-embed only new memories
      |
      v
update last_indexed_sha
```

Deleted/renamed source files invalidate their old memories. Removed routes are preserved with `active=0` and `removed_sha` for history.

## List routes

```bash
npm run memory -- routes hangikredi.deposit.fe.next
```

Routes are structured rows, not vector-only facts. Queries such as “show every route in repo X” can therefore be answered deterministically.

## Dependencies and changes

```bash
npm run memory -- dependencies hangikredi.deposit.fe.next
npm run memory -- route-dependencies hangikredi.deposit.fe.next --route=/account
npm run memory -- changes hangikredi.deposit.fe.next --since=<40-char-git-sha>
```

`changes` reports CREATE/DEACTIVATE events after the requested successful indexed SHA; unchanged REUSE events remain internal audit data.

## Search

Exact + semantic hybrid:

```bash
npm run memory -- search "middleware access_token cookie"
```

Restrict to a repository:

```bash
npm run memory -- search "dynamic rendering cookies" --repo=hangikredi.deposit.fe.next --limit=10
```

## Codex and Claude through MCP

Build and start the local stdio MCP server:

```bash
npm run build
npm run mcp
```

The server exposes three read-only tools: `memory_repository` and `memory_route` for exact inventory, plus intent-aware `memory_context` for bounded flow, impact, debug, implementation, verification, change-review, point-in-time, behavior-diff, approved-decision and lookup packs. Quality, snapshot and decision-ingest commands remain available through the CLI. See [AI_USAGE.md](docs/AI_USAGE.md) for one-time Codex/Claude registration commands and the memory-first agent policy.

## Reconciliation and quality

```bash
npm run memory -- reconcile hangikredi.deposit.fe.next
npm run memory -- reconcile-all
npm run memory -- quality hangikredi.deposit.fe.next
npm run memory -- evaluate
```

`evaluate` measures Recall@K for the retrieval smoke suite. `context-eval` runs the task-level Repository Context Engine suite instead: it executes each case's MCP tool plan, measures engine context against the source files a memory-less agent would have to open, and reports required-evidence recall per case.

```bash
npm run memory -- context-eval                                  # config/context-engine-eval.json
npm run memory -- context-eval config/context-engine-eval.json  # explicit suite
```

`context-economy` reads a `context-eval` run back and splits the cost ledger: the fixed per-session cost of the MCP tool schemas, server instructions and the repository policy block, against the per-question payload. It reports both a nominal saving (the pack replaces the source read) and an effective saving (only a clean pack replaces it). Cache and total-context figures stay `null` — only the client knows those.

```bash
npm run memory -- context-economy --policy=../your-repo/AGENTS.md
```

Answer quality is deliberately not scored by the harness; each case carries an empty `answerScore` for a human or agent pass. Results are recorded in [the RCE-002 baseline](docs/REPOSITORY_CONTEXT_ENGINE_BASELINE.md).

Set `MEMORY_RECONCILE_INTERVAL_MINUTES=60` when running `npm run serve` to enable hourly reconciliation. Unchanged hashes retain their memory IDs and vectors.

Optional AI enrichment is an explicit command and is never invoked by normal indexing/search:

```bash
MEMORY_AI_EXTRACTOR_URL=http://127.0.0.1:8080/extract \
npm run memory -- ai-extract hangikredi.deposit.fe.next --file=src/app/page.tsx
```

## MCP over HTTP

`serve` exposes the same three tools at `/mcp`, for clients that connect by URL instead of spawning a
process. One factory backs both entries, so an HTTP client and a stdio client always see an identical
surface — verified by a test.

```bash
pnpm serve   # http://127.0.0.1:4317/mcp
```

Cursor (Settings → MCP → Add), or `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "frontend-memory": { "url": "http://127.0.0.1:4317/mcp" } } }
```

Claude Code keeps working over stdio against `dist/mcp/server.js`; nothing about that changes. Use
stdio when the client can spawn a process and HTTP when it cannot, or when several editors should
share one running index.

Serving is stateless: each request gets a fresh server over the shared database handle, so no session
state accumulates in the long-running process.

**Exposure.** The server binds to `127.0.0.1` by default and the MCP endpoint performs no
authentication. Setting `MEMORY_HOST=0.0.0.0` publishes the read-only MCP tools *and* the existing
`POST /sync` and `POST /full-index` endpoints to the network. Put it behind a reverse proxy with auth
before doing that.

## Browser readout

`serve` also hosts a read-only UI at the same port. It pages through every indexed repository and
draws the index from live data — no fixture, no snapshot file.

```bash
pnpm serve        # http://127.0.0.1:4317
```

- **Projection** — every stored fact placed by the principal components of its own embedding.
  The explained variance is printed next to the plot, because the picture is lossy and says so.
- **Vector search** — a typed question is embedded server-side and matched against the index by
  `sqlite-vec`; the similarities shown are the ones the retrieval path uses.
- **Neighbours** — clicking a fact pulls its nearest neighbours from the vector table, not from a
  similarity recomputed in the browser.
- **Traversal** — a real walk over the typed symbol graph, with the client-to-server boundary marked
  and helper detail pruned.

Endpoints behind it: `/api/ui/projects`, `/api/ui/projection/:repository`,
`/api/ui/neighbours/:repository?id=`, `/api/ui/vector-search/:repository?q=`, `/api/ui/flow/:repository`.
Projections are cached per indexed SHA and rebuilt when the index moves.

## HTTP server

```bash
npm run serve
```

Default: `http://127.0.0.1:4317`

Endpoints:

```text
GET  /health
GET  /repositories
GET  /quality?repo=...
GET  /repositories/:name
GET  /repositories/:name/routes
GET  /repositories/:name/dependencies
GET  /repositories/:name/route-dependencies?route=/path
GET  /repositories/:name/changes?since=<commit>
GET  /search?q=...&repo=...&limit=10
POST /full-index   { "repository": "...", "commit": "<40-char SHA>" }
POST /sync         { "repository": "...", "commit": "<40-char SHA>" }
```

### CI example

After a successful merge/deploy pipeline has checked out the new `main`:

```bash
curl -X POST http://memory-service:4317/sync \
  -H 'content-type: application/json' \
  -d '{"repository":"hangikredi.deposit.fe.next","commit":"'"$GIT_COMMIT"'"}'
```

Only the central Memory Service writes SQLite. Do **not** mount the same SQLite DB into 16 parallel CI jobs and let them write it directly.

## Data model

Core tables:

```text
repositories
index_runs
index_run_changes
routes
memories
memory_evidence
dependencies
route_dependencies
memory_fts
memory_vectors_v2 (sqlite-vec)
```

Every semantic memory has source evidence and a commit SHA. This is intentional: memory must be invalidated when its source changes.

## Route behavior

Examples recognized:

```text
src/app/page.tsx                     -> /
src/app/(public)/about/page.tsx      -> /about
src/app/products/[slug]/page.tsx     -> /products/[slug]
src/app/api/revalidate/route.ts      -> /api/revalidate
pages/index.tsx                       -> /
pages/blog/[slug].tsx                -> /blog/[slug]
pages/api/menu.ts                     -> /api/menu
```

App route groups `(group)` and parallel slot segments `@slot` are not included in the public URL. Intercepting route markers `(.)`, `(..)`, `(..)(..)` and `(...)` are normalized using Next.js route-segment semantics.

## Important limitations

This remains conservative static analysis, not a full TypeScript semantic compiler or runtime tracer.

- Rendering detection is evidence-based but heuristic. Layouts and statically reachable local imports are modeled, but static reachability alone does not prove that every imported function executes at runtime.
- `auth_required` is a code-signal field, not proof of production authorization.
- `fetch()` target extraction preserves expressions; it does not invent a service name.
- Optional AI capabilities/rules are stored only after confidence and exact source-evidence validation; normal sync never makes an external LLM request. Deterministic business rules require an explicit `BUSINESS_RULE:` source annotation.
- `auth_required` and middleware behavior remain source-code signals, not proof of deployed authorization behavior.
- Static import reachability and client/API call detection are conservative code facts; they do not prove that every path executes at runtime.

## Recommended next steps

1. Register the MCP server in Codex and Claude and add the memory-first agent guidance to the target repository.
2. Expand `config/retrieval-evaluation.json` with real engineering questions and track Recall@K.
3. Keep CI incremental sync enabled after main merges; use scheduled reconciliation as drift protection.
4. Grow through the measured 2 → 4 → 8 → 16 waves; require `rollout-status` to return `advance` before each wave.
