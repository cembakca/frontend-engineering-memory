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

Yeni bir repository eklemek veya mevcut repository'yi yeni commit'e taşımak için baştan sona operasyon sırası [Project lifecycle guide](docs/PROJECT_GUIDE.md) içinde yer alır.

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
      "managedCheckout": false
    }
  ]
}
```

Developer working trees should use `managedCheckout:false`. A service-owned clean clone may use `managedCheckout:true` with a configured remote. Dirty working trees are refused; the indexer never resets a developer checkout.

Route slugs, data-source names, client boundaries and backend identifiers are converted into repository vocabulary automatically during indexing. `queryAliases` remains an optional override for exceptional terminology; normal onboarding does not require it.

Create the first index, generated evaluation overlay and fleet assignment with one command:

```bash
pnpm onboard
```

The command discovers incomplete registry entries. Add `--evaluate` to run the complete retrieval fleet after structural validation, or pass a repository name to force one target.

The default database is created at `data/engineering-memory.sqlite`. The first vector operation downloads the pinned local `multilingual-e5-small-v1` profile.

## MCP

The server exposes three read-only tools:

| Tool | Purpose |
| --- | --- |
| `memory_repository` | Repository profiles and cross-repository package links |
| `memory_route` | Route inventory and fleet lookup; exact lookup defaults to a bounded route/source/rendering summary with optional `runtime`, `dependencies`, or `full` projection |
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
- Webhook: `http://127.0.0.1:4317/webhook`
- Health: `http://127.0.0.1:4317/health`

Copy the policy block from `config/AGENTS.memory.example.md` into the target repository's `AGENTS.md` or equivalent agent instructions. See [Agent integrations](docs/INTEGRATIONS.md) for complete setup guidance.

## Daily operation

After changes reach the indexed branch:

```bash
pnpm sync:all
```

`sync:all` (`pnpm memory sync-all`) isolates failures by repository. A clean repository with no new commit returns `NOOP`; changed repositories receive route reconciliation, incremental analysis, memory invalidation, and vector updates. `pnpm index:all` re-analyses every repository from scratch — needed after an analyzer change, since existing memories were written by the previous revision. `pnpm registry:sync` reconciles the registry itself: new entries are indexed, removed ones retired.

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

### Throwing the index away

```bash
pnpm reset                      # report what would be destroyed; delete nothing
pnpm reset --yes                # empty every table, keep the schema
pnpm reset --scope=index --yes  # indexed knowledge only, keep telemetry and feedback
pnpm reset --hard --yes         # delete the database file and its journals
pnpm index:all                  # rebuild from the repositories
```

`reset` is irreversible and never runs without `--yes`: without it the command
prints the row counts and repositories it would remove and exits non-zero.
Indexed knowledge is reproducible — `index:all` rebuilds it from the
repositories — but retrieval telemetry, answer feedback and approved decision
records are not, which is why `--scope=index` exists. A hard reset removes the
file the running configuration points at (`MEMORY_DB_PATH`); the schema is
recreated on the next run.

### The registry is the only file you edit

`config/repositories.json` is watched while `pnpm serve` runs. Saving it is the whole operation:

| Registry edit | Result |
| --- | --- |
| Entry added | Cloned if it has a `url`, then indexed |
| Entry removed | Retired — leaves the UI, MCP and retrieval; rows are kept |
| Entry re-added | Restored as it was, without re-indexing |

The watch settles membership only — added, removed, re-added. New commits arrive through the webhook,
so a repository whose CI trigger is missing stays visibly stale rather than being quietly kept fresh.

Retirement is reversible on purpose: a typo in a JSON file should not destroy an index.
`pnpm memory registry-retired [--purge=<name>]` lists and, when you are sure, reclaims the space.
`pnpm memory registry-sync` runs the same reconciliation by hand.

### Repositories the service checks out itself

Give a registry entry a `url` instead of a `path` and the engine owns the checkout: it clones on first
sync, then fetches and hard-resets to the indexed branch on every sync after that. Nobody works in it,
so it is never dirty and no `git status` dance is needed before indexing.

```bash
pnpm memory repo-add company.web.next --url=git@gitlab.com:company/company.web.next.git
pnpm memory sync company.web.next
```

Clones land in `MEMORY_WORKSPACE` (default `data/repos/<name>`). Pointing an existing service-owned
checkout at a different `url` is refused rather than silently reused.

### Triggering sync from CI

`POST /webhook` accepts GitLab push, GitHub push, and a plain `{"repository","commit"}` body. When the
payload carries a clone URL the repository is matched against the registry `url`, so the sender needs
no knowledge of local names.

```bash
export MEMORY_WEBHOOK_SECRET=…      # required for any caller that is not loopback
curl --fail -X POST "http://127.0.0.1:4317/webhook?wait=1" \
  -H 'content-type: application/json' -H "x-memory-token: $MEMORY_WEBHOOK_SECRET" \
  -d '{"repository":"company.web.next","commit":"<40-char sha>"}'
```

Queued by default (`202`) because indexing outlasts a webhook timeout; `?wait=1` returns the sync
result for a pipeline that should fail when the index fails. A push to a branch the repository is not
indexed from is reported as a deliberate skip, not an error. The Jenkins pipeline, the credential
headers each host sends, and the full response table are in [Operations](docs/OPERATIONS.md).

Günlük kısa komutların ötesindeki yeni proje ve proje güncelleme akışları için [Project lifecycle guide](docs/PROJECT_GUIDE.md), daha büyük rollout ve managed checkout işletimi için [Operations](docs/OPERATIONS.md) dokümanını kullanın.

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
pnpm memory context-eval
pnpm eval:fleet:validate
pnpm eval:fleet
pnpm memory security-audit
```

`context-eval` executes one repository's task-level MCP plans. `eval:fleet` validates architecture-family coverage and evaluates every registered repository suite as one gate. Add real engineering questions as curated regressions; do not expand extraction or change embeddings without a measured miss.

Two enforced architecture families are checked in: `content-site` and `product-app`. Their representatives carry 10–15 curated cases; future repositories receive a source-derived 5–7 case smoke overlay during onboarding:

```bash
pnpm onboard company.web.next --evaluate
```

The fleet manifest rejects drafts, placeholder strict facts, missing job categories, unregistered assignments, uncovered registered repositories, stale target SHAs, dirty trees, strict misses, and quality below the configured recall/context thresholds.

The evaluation contract and 50-question golden catalog live in [Evaluation](docs/EVALUATION.md).

## Security and privacy

- Environment key names may be indexed; environment values are not.
- The SQLite database, local repository registry, `.env`, model cache, and evaluation runs are ignored by Git.
- Telemetry stores query shape/hash by default, not question text or retrieved fact bodies.
- MCP tools are read-only.
- The HTTP server binds to `127.0.0.1` by default. `POST /webhook` is the one endpoint that authenticates: it requires `MEMORY_WEBHOOK_SECRET` from any caller that is not loopback, and compares the credential in constant time.

`/sync` and `/full-index` still have no authentication of their own, so do not expose `MEMORY_HOST=0.0.0.0` without an authenticated reverse proxy. Prefer `/webhook` for anything reaching the service from another host.

## Deliberate limits

This is conservative static analysis, not a TypeScript compiler or runtime tracer. It does not prove that every code path executes in production. Unknown or insufficient evidence is surfaced through the answer contract.

The current scope intentionally excludes:

- OpenAPI/GraphQL schema ingestion
- monorepo workspace modeling
- instrumentation and runtime/build-manifest evidence
- external incoming-consumer discovery

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Project lifecycle guide](docs/PROJECT_GUIDE.md)
- [Agent integrations](docs/INTEGRATIONS.md)
- [Operations](docs/OPERATIONS.md)
- [Evaluation](docs/EVALUATION.md)
- [Embedding model](docs/EMBEDDINGS.md)
- [Feature analysis & delivery roadmap](docs/FEATURE_ANALYSIS_ROADMAP.md)

## Development status

The repository is production-ready for controlled Next.js fleet use. Expansion is gated in `2 → 4 → 8 → 16` waves by freshness, security, evidence coverage, duplication, latency, and evaluation quality.

This package remains marked `private` because it is currently distributed as source/service infrastructure rather than as a public npm package.
