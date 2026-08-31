# Operations and fleet onboarding

The service keeps multiple Next.js repositories in one database while preserving repository identity in every structured row, memory, vector, graph edge, and retrieval result.

## Repository modes

Use `managedCheckout:false` for a developer working tree:

```json
{
  "name": "company.web.next",
  "path": "/work/company.web.next",
  "mainBranch": "main",
  "managedCheckout": false
}
```

Use `managedCheckout:true` only when the service owns a dedicated clean clone:

```json
{
  "name": "company.web.next",
  "path": "/srv/frontend-memory/repos/company.web.next",
  "mainBranch": "main",
  "managedCheckout": true,
  "remote": "origin"
}
```

Managed sync fetches the configured remote and refreshes only that dedicated checkout. A dirty checkout is refused in either mode.

## First index

Start with one repository:

```bash
pnpm memory full company.web.next
pnpm memory embedding-status
pnpm memory quality company.web.next
pnpm memory security-audit company.web.next
```

Then index the configured fleet:

```bash
pnpm memory full-all
pnpm memory rollout-status
```

Batch commands isolate failures per repository and return a non-zero exit code if any target fails.

## Rollout waves

Grow through the configured `2 → 4 → 8 → 16` waves. At every wave:

1. Add repository entries to the local `config/repositories.json`.
2. Add representative real questions to `config/context-engine-eval.json`.
3. Run `full` for a new architecture shape, then `full-all`.
4. Check embeddings, security, freshness, and repository quality.
5. Run the context evaluation and economy report.
6. Pass their files to `pilot-gate`/`rollout-status` when they are not at the default local paths.
7. Do not expand while the decision is `hold` or evidence is insufficient.

Health floors are defined in `config/rollout-gates.json`; they currently require:

- freshness `fresh` or `tree-dirty`
- zero security-audit failures
- duplication ratio no greater than `0.05`
- evidence coverage at least `0.95`
- database size per repository no greater than 50 MB
- retrieval p95 no greater than 5 seconds

## Daily sync

After main-branch updates:

```bash
pnpm memory sync-all
pnpm memory freshness
pnpm memory rollout-status
```

Incremental sync always reconciles routes, analyzes changed source surfaces, deactivates stale memories, updates snapshots, and embeds only new facts. An unchanged clean repository returns `NOOP`.

Enable scheduled drift reconciliation while the HTTP service runs:

```bash
MEMORY_RECONCILE_INTERVAL_MINUTES=60 pnpm serve
```

The scheduler is a safety net. A CI sync after each main merge gives lower freshness latency.

## CI

Examples live under `ci/`. For HTTP-triggered indexing, send the full expected 40-character commit SHA. The server rejects ambiguous or stale commit expectations.

The service binds to localhost by default. If it must be exposed to a network, place it behind an authenticated reverse proxy before changing `MEMORY_HOST`.

## Evaluation artifacts

Evaluation outputs are local operational data and are not committed. Suggested paths:

```text
eval-results/rce-002-final.json
eval-results/rce-004-economy-final.json
```

Run the evaluation and save its JSON output, then compute economy from that run:

```bash
pnpm exec tsx src/cli.ts context-eval > eval-results/rce-002-final.json
pnpm memory context-economy --run=eval-results/rce-002-final.json --policy=/path/to/target/AGENTS.md
```

Store the economy output at the configured default name or pass it explicitly to the rollout command.

## Backup and recovery

The SQLite database is derived data. Back it up if retaining telemetry, feedback, decisions, or historical snapshots matters; otherwise it can be rebuilt from registered repositories plus approved decision inputs.

Before a model/profile migration, use a separate database or preserve the existing file. Vector tables are fingerprinted, but an A/B run should not share operational state accidentally.

## Troubleshooting

### Working tree must be clean

Commit, stash, or revert changes in the target repository. The indexer deliberately refuses to label uncommitted files with the current commit SHA.

### MCP client sees an old schema

Run `pnpm build` and restart the MCP process/client.

### Vector coverage is below 1

Run:

```bash
pnpm memory vectors company.web.next
pnpm memory embedding-status
```

### Rollout reports insufficient evidence

Generate current context-evaluation and economy artifacts. Published source does not include environment-specific evaluation runs.
