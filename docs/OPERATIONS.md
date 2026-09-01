# Operations and fleet onboarding

The service keeps multiple Next.js repositories in one database while preserving repository identity in every structured row, memory, vector, graph edge, and retrieval result.

Yeni repository ekleme ve mevcut repository'yi yeni commit'e taşıma işlemlerinin copy/paste edilebilir sırası için [Project lifecycle guide](PROJECT_GUIDE.md) dokümanını kullanın. Bu sayfa servis modu, rollout, CI, backup ve troubleshooting ayrıntılarına odaklanır.

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

After adding entries to `config/repositories.json`, onboard every incomplete repository:

```bash
pnpm onboard --evaluate
pnpm memory embedding-status
pnpm memory quality
pnpm memory security-audit
```

To rebuild every configured repository explicitly:

```bash
pnpm onboard --all --evaluate
pnpm memory rollout-status
```

Batch commands isolate failures per repository and return a non-zero exit code if any target fails.

## Rollout waves

Grow through the configured `2 → 4 → 8 → 16` waves. At every wave:

1. Add repository entries to the local `config/repositories.json`.
2. Run `pnpm onboard --evaluate`; incomplete registry entries are discovered and indexing, vocabulary, family inference, generated overlay, fleet assignment and validation run as one idempotent operation.
3. Check embeddings, security, freshness and repository quality.
4. Run the economy report.
5. Pass run files to `pilot-gate`/`rollout-status` when they are not at the default local paths.
6. Do not expand while either fleet or rollout decision is `hold`.

`queryAliases`, family and suite files are not normal hand-authored onboarding inputs. Curated suites remain supported as long-lived regression assets and are preserved by `onboard`.

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

Actionable feedback can be exported into an evaluation-suite draft:

```bash
pnpm memory feedback export company.web.next --state=triaged
```

The export deliberately remains `ready:false` until a human supplies the exact question when telemetry text was disabled, expected source evidence, and the strict fact. This prevents an unreviewed complaint from becoming a weak regression test.

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
