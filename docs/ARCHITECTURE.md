# Architecture

```text
                    Next.js repositories
                             │
               full / incremental / reconcile
                             │
              ┌──────────────┴──────────────┐
              │                             │
        structural analysis          source-fact analysis
   routes · config · packages     AST facts · symbols · tests
              │                             │
              └──────────────┬──────────────┘
                             │
                       atomic SQLite
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
 structured inventory      FTS5              sqlite-vec
 routes · dependencies   exact terms      local embeddings
 snapshots · decisions                         │
       │                     │                  │
       └─────────────────────┴──────────────────┘
                             │
                  task-aware context compiler
       SQL · search · flow · impact · verification · time
                             │
                    three read-only MCP tools
                  Codex · Claude · Cursor · local agents
```

## Source of truth

Executable repository source is authoritative. Every stored fact carries repository identity, evidence path, optional symbol/range, file hash, and indexed SHA. Facts are deactivated when evidence changes or disappears. Successful indexing commits repository profile, routes, dependencies, memories, vectors, graph snapshots, and run audit atomically.

The index never treats an uncommitted working tree as a commit snapshot. Managed checkout mode is limited to service-owned clones.

## Analysis layers

### Structured inventory

SQL owns facts that must be exact: repository profiles, route inventory, route behavior, dependencies, cross-repository package links, snapshots, approved decisions, telemetry, and feedback.

Routes are never vector-only. Unicode aliases are normalized only during lookup; the real route stored from the repository is preserved.

### Focused memories

Deterministic analyzers emit source-backed facts for behavior not fully represented by structural rows: cache semantics, server boundaries, schemas, authorization, analytics, error conditions, configuration usage, and other implementation signals.

The engine does not create a generic summary for every file. Acceptance rules reject path-derived or duplicative records before they consume retrieval slots.

### Semantic graph

The symbol graph connects modules, symbols, components, Server Functions, routes, APIs, configuration keys, cache keys, packages, tests, and verification commands. Stored edges are source observations; flow and impact closures are derived at query time so reverse relationships cannot become stale.

### Retrieval

Query planning selects bounded channels:

- SQL for exact repository and route identities
- FTS5 for technical names and literals
- vector KNN for semantically related wording
- forward graph traversal for execution flow
- reverse graph traversal for change impact
- verification graph for commands, tests, and explicit gaps
- immutable snapshots for point-in-time context and behavior diff

Ranking operates on canonical entities, not raw occurrences. Repository scope is applied before vector KNN.

## Context contract

`memory_context` emits task-specific packs rather than a generic search dump. Every pack has a character budget and an `answerContract` that identifies:

- source-backed facts
- statically derived relations
- inferred claims
- uncertainty reasons
- missing evidence
- targeted source fallback

The calling agent should open only fallback files when the pack is insufficient.

## Embeddings

The embedding profile is an immutable contract containing model, revision, dimension, dtype, and query/passage prefixes. Its fingerprint selects the vector table, preventing vectors from incompatible profiles from mixing.

The default profile is local `multilingual-e5-small-v1`. FTS/SQL remain available when embeddings are disabled.

## Temporal and decision memory

Each successful index stores an immutable behavior snapshot at its Git SHA. Historical queries accept only indexed SHAs and never silently fall back to HEAD.

Decision rationale is separate from source-derived facts. Only approved ADR, PR, issue, or human records may supply “why” answers, and explicit supersession preserves decision history.

## Security boundaries

Normal full/sync/retrieval never calls an external LLM. Optional AI extraction is explicit and evidence-gated. Environment values are excluded, telemetry is allowlisted, question text storage is opt-in, and MCP tools are read-only.

The HTTP service is unauthenticated and localhost-only by default. Network exposure requires an authenticated boundary.
