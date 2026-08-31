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

The first semantic indexing/search downloads the local embedding model (`Xenova/multilingual-e5-small`) through Transformers.js. Set `MEMORY_EMBEDDINGS_ENABLED=0` if you want deterministic + FTS indexing only.

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

The server exposes read-only, token-bounded tools for repository profiles, routes, dependencies, hybrid search, changed memories, explanation context and quality metrics. See [AI_USAGE.md](docs/AI_USAGE.md) for one-time Codex/Claude registration commands and the memory-first agent policy.

## Reconciliation and quality

```bash
npm run memory -- reconcile hangikredi.deposit.fe.next
npm run memory -- reconcile-all
npm run memory -- quality hangikredi.deposit.fe.next
npm run memory -- evaluate
```

Set `MEMORY_RECONCILE_INTERVAL_MINUTES=60` when running `npm run serve` to enable hourly reconciliation. Unchanged hashes retain their memory IDs and vectors.

Optional AI enrichment is an explicit command and is never invoked by normal indexing/search:

```bash
MEMORY_AI_EXTRACTOR_URL=http://127.0.0.1:8080/extract \
npm run memory -- ai-extract hangikredi.deposit.fe.next --file=src/app/page.tsx
```

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
4. Add more repositories only after the current pilot's retrieval precision is satisfactory.
