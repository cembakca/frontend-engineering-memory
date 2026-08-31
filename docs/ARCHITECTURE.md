# Architecture

```text
                 Next.js repositories
                        |
              merge to main/master
                        |
                        v
                 Memory Sync API
                        |
          optional managed Git refresh
                        |
              last SHA -> current SHA
                        |
              +---------+----------+
              |                    |
              v                    v
       full route rescan       git diff
              |                    |
              |            change classifier
              |            + impact graph
              |                    |
              |          deterministic analyzers
              |                    |
              +---------+----------+
                        |
                        v
                    SQLite
       +----------------+----------------+
       |                |                |
   structured          FTS5          sqlite-vec
 routes/dependencies                  repo partition
 route_dependencies                   + type filter
       metadata                       |
                                      v
                        @huggingface/transformers
                        local multilingual embeddings
                                      |
                                      v
                         token-bounded MCP tools
                         Codex / Claude clients
```

## Source of truth

Executable repository source is the source of truth. Stored facts retain evidence (`file_path`, optional symbol/range, file hash, indexed SHA). Before analysis, the configured branch, clean working tree and expected commit are verified. When an evidence file changes, its old memory version is deactivated with `removed_sha`, removed from active FTS/vector indexes and regenerated. The complete new snapshot is committed atomically. Unchanged `source_hash` records retain the same memory/vector identity.

## Why routes are not vector-only

Routes are first-class structured data. Exact questions such as “list all active routes in repository X” must be answered with SQL, not approximate nearest-neighbor search.

## Retrieval strategy

- Structured SQL: versions, repository profile, route inventory.
- FTS5: exact technical terms (`access_token`, package names, Next.js APIs).
- Vector: conceptual questions where wording differs; repository partition and memory type metadata are filtered inside KNN.
- Hybrid search: query understanding selects channels and combines their scores with channel provenance.

Agent-facing retrieval is deliberately bounded. MCP tools return compact structured results; `memory_explain` assembles a small evidence-bearing context packet with result and character limits. The agent is instructed to query memory first and open repository files only when the returned evidence is insufficient. This avoids sending an entire repository—or large generated summaries—to an LLM on every task.

## Dependency and audit model

Package, internal package, HTTP and configuration dependencies are structured rows. Route usage is represented by `route_dependencies` with source file, symbol and line. Every indexing run records CREATE/DEACTIVATE/REUSE operations in `index_run_changes`; `changed_since` returns user-visible CREATE/DEACTIVATE changes after a Git SHA.

## AI extraction boundary

Normal indexing and retrieval only write facts detected deterministically and never call an external LLM. Optional business interpretation is a separate, explicit `ai-extract` operation. Its output is accepted only for supported types, above the configured confidence threshold, and when an exact quote can be verified inside the declared file and line range. AI-produced memories retain producer/quality metadata and are invalidated when their evidence file changes.

## Reconciliation and quality

Manual or scheduled reconciliation compares the registered repository's clean current SHA and uses the same hash-aware sync path. Quality reporting measures evidence, commit, line, symbol and vector coverage. A checked-in evaluation set exercises SQL, FTS and vector retrieval and reports Recall@K. Custom Next.js `distDir` output is excluded from analysis so generated bundles cannot dominate retrieval.
