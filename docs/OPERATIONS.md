# Operations and fleet onboarding

The service keeps multiple Next.js repositories in one database while preserving repository identity in every structured row, memory, vector, graph edge, and retrieval result.

Yeni repository ekleme ve mevcut repository'yi yeni commit'e taşıma işlemlerinin copy/paste edilebilir sırası için [Project lifecycle guide](PROJECT_GUIDE.md) dokümanını kullanın. Bu sayfa servis modu, rollout, CI, backup ve troubleshooting ayrıntılarına odaklanır.

## The registry is the only file you edit

`config/repositories.json` is the source of truth, and `serve` acts on it. The file is watched, so a
save is the whole operation — no command follows it:

| You do | The service does |
| --- | --- |
| Add an entry with a `url` | Clones it and runs a first full index |
| Add an entry with a `path` | Indexes that checkout |
| Remove an entry | Retires the repository: it leaves the UI, MCP and retrieval, and its rows are kept |
| Re-add an entry you removed | Restores it as it was, without re-indexing |
| Change nothing | Nothing |

The watch settles *membership* only. It does not pull commits for repositories that are already
indexed: that is the webhook's job, and a registry edit re-indexing unrelated projects would be a
surprise. It also means a repository whose CI trigger was never wired up stays visibly stale instead
of being quietly kept fresh by a fallback.

Removal retires rather than deletes, because a registry edit is easy to get wrong and a typo should
not destroy an index. `pnpm memory registry-retired` lists what is retired and
`pnpm memory registry-retired --purge=<name>` reclaims the space once you are sure.

One broken entry never blocks the others: it is reported and the rest of the pass continues.

Run the same reconciliation by hand at any time:

```bash
pnpm memory registry-sync                 # add, sync, retire
pnpm memory registry-sync --only-new      # index newly added entries, skip commit checks
pnpm memory registry-sync --no-retire     # never retire, whatever the registry says
```

`MEMORY_REGISTRY_WATCH=0` turns the watch off.

`MEMORY_RECONCILE_INTERVAL_MINUTES` adds a periodic pass that *does* check for new commits. It is off
by default and should stay off where CI posts to the webhook: a polling fallback would mask a
repository whose pipeline was never connected, which is exactly the failure you want to see.

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

Give a `url` when the service should own the checkout. No path, no manual clone:

```json
{
  "name": "company.web.next",
  "url": "git@gitlab.com:company/company.web.next.git",
  "mainBranch": "main"
}
```

The engine clones into `MEMORY_WORKSPACE` (default `data/repos/<name>`) on first sync, then fetches
and hard-resets to `<remote>/<branch>` on every sync after that. `managedCheckout` defaults to true
whenever a `url` is present, so it does not need to be written out.

Register one without editing the file by hand:

```bash
pnpm memory repo-add company.web.next --url=git@gitlab.com:company/company.web.next.git
pnpm memory sync company.web.next        # clones, then full-indexes on first run
```

Pointing an existing service-owned checkout at a different `url` is refused rather than silently
re-used: indexing the wrong repository under a familiar name is worse than a failed sync. Move the
old checkout aside or fix the registry.

`path` and `url` may both be given when the clone must live somewhere specific. Credentials are the
host's: the engine shells out to `git`, so SSH keys or a credential helper must already work for the
user running the service.

Managed sync refreshes only that dedicated checkout. A dirty checkout is refused in either mode —
but a service-owned checkout is never dirty in practice, because nobody works in it.

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

### Webhook

`POST /webhook` is the endpoint to point CI or a Git host at. It takes the commit from the payload —
never from whatever the checkout currently happens to be on — so a delivery can only index what the
sender named.

**Authentication.** Set `MEMORY_WEBHOOK_SECRET` before exposing the service. Any one of these is
accepted, compared in constant time:

| Header | Sender |
| --- | --- |
| `X-Gitlab-Token: <secret>` | GitLab |
| `X-Hub-Signature-256: sha256=<hmac>` | GitHub (HMAC of the raw body) |
| `X-Memory-Token: <secret>` or `Authorization: Bearer <secret>` | Jenkins, curl, anything else |

Without the secret set, only loopback callers are accepted. An unauthenticated endpoint reachable
from the network would let anyone queue indexing work, so it refuses rather than trusting a
well-formed request.

**Payloads.** GitLab push, GitHub push, and a plain `{"repository","commit"}` body all work. When the
payload carries a clone URL, the repository is matched against the registry `url` — so a Git host
webhook needs no knowledge of the names this service uses. `?repository=` and `?commit=` override.

**Responses.**

| Status | Meaning |
| --- | --- |
| `202` + `mode:"queued"` | Accepted; indexing runs in the background |
| `202` + `accepted:false` | Deliberate skip, e.g. a push to a branch this repository is not indexed from |
| `200` | Only with `?wait=1`; the body carries the sync result |
| `401` | Missing or wrong credential |
| `404` | Payload matched no registered repository |

Queued is the default because indexing takes minutes and a Git host times out long before that. Use
`?wait=1` from a pipeline that should fail when the index fails.

The same repository and commit is never indexed twice concurrently: a delivery that arrives while its
own sync is still running joins the run in flight.

```bash
curl --fail -X POST "$FRONTEND_MEMORY_URL/webhook?wait=1" \
  -H 'content-type: application/json' \
  -H "x-memory-token: $MEMORY_WEBHOOK_SECRET" \
  -d "{\"repository\":\"company.web.next\",\"commit\":\"$GIT_COMMIT\"}"
```

### Jenkins on merge to main

With a `url`-defined repository the pipeline needs no checkout of its own and no shared filesystem
with the memory service — it posts the commit and the service fetches it:

```groovy
pipeline {
  agent any
  stages {
    stage('Sync engineering memory') {
      when { branch 'main' }
      steps {
        sh """
          curl --fail --silent --show-error --max-time 600 \
            -X POST "\$FRONTEND_MEMORY_URL/sync" \
            -H 'content-type: application/json' \
            -d '{"repository":"company.web.next","commit":"\$GIT_COMMIT"}'
        """
      }
    }
  }
}
```

`POST /sync` is safe as the only trigger: a repository that has never been indexed falls back to a
full index automatically, and one whose last indexed SHA is not an ancestor of the new head does the
same. Writes are queued, so concurrent pipelines cannot interleave two index runs.

Use the repository's registry `name`, not `JOB_BASE_NAME`, unless the two are guaranteed equal.

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

If this keeps interrupting an automated flow, the repository is registered as a developer working
tree. Re-register it with a `url` so the service owns a clone of its own and stops depending on
whatever state a developer left behind.

### Clone refuses to start

`Refusing to clone into a non-empty directory` means the workspace path already holds something the
engine did not create. Remove it or point `MEMORY_WORKSPACE` elsewhere.

`Checkout at … points at …` means the registry `url` changed after the clone existed.

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
