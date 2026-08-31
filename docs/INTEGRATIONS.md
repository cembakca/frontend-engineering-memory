# Agent integrations

Frontend Engineering Memory is model-independent. Codex, Claude, Cursor, or a local model can use the same read-only MCP server as long as the client supports MCP tool calls.

## Build the stdio server

```bash
pnpm install
pnpm build
```

Resolve the project directory once:

```bash
pwd
```

Use that absolute path in the example configurations under `config/`.

## Codex

Copy `config/codex-mcp.example.toml` into the appropriate Codex configuration and replace `/ABSOLUTE/PATH/frontend-engineering-memory`.

Equivalent CLI registration:

```bash
codex mcp add frontend-memory \
  --env MEMORY_DB_PATH=/ABSOLUTE/PATH/frontend-engineering-memory/data/engineering-memory.sqlite \
  --env MEMORY_REPOSITORIES_FILE=/ABSOLUTE/PATH/frontend-engineering-memory/config/repositories.json \
  --env MEMORY_EMBEDDINGS_ENABLED=1 \
  -- node /ABSOLUTE/PATH/frontend-engineering-memory/dist/mcp/server.js
```

Verify with `codex mcp list`, then restart the active client after changing the server build or schema.

## Claude Code

Use `config/claude-mcp.example.json` or register the stdio server:

```bash
claude mcp add frontend-memory --scope user \
  --env MEMORY_DB_PATH=/ABSOLUTE/PATH/frontend-engineering-memory/data/engineering-memory.sqlite \
  --env MEMORY_REPOSITORIES_FILE=/ABSOLUTE/PATH/frontend-engineering-memory/config/repositories.json \
  --env MEMORY_EMBEDDINGS_ENABLED=1 \
  -- node /ABSOLUTE/PATH/frontend-engineering-memory/dist/mcp/server.js
```

Verify with `claude mcp list`.

## Cursor and HTTP clients

Start the shared local service:

```bash
pnpm serve
```

Configure the client with `config/cursor-mcp.example.json` or point any Streamable HTTP MCP client at:

```text
http://127.0.0.1:4317/mcp
```

Use stdio when one client owns the process. Use HTTP when several local editors share the same index.

## Tool policy

The MCP surface intentionally stays small:

| Tool | Use |
| --- | --- |
| `memory_repository` | List repositories, inspect profiles, and traverse repository package links |
| `memory_route` | List routes, locate a route across the fleet, or inspect one route's behavior and dependencies |
| `memory_context` | Compile one task-aware, evidence-backed context pack |

For a fleet-wide route lookup, omit `repository` from `memory_route`. Unicode and Turkish aliases are normalized for lookup while the actual indexed route remains unchanged.

For engineering questions, pass the known repository to `memory_context` and call it once. Follow `answerContract`; inspect only the listed `sourceFallback` files if uncertainty remains.

Add the policy in `config/AGENTS.memory.example.md` to each target repository's `AGENTS.md`, `CLAUDE.md`, or equivalent instructions. Do not load the SQLite database or the entire repository into model context.

## Local LLMs

The chat model and embedding model are independent. The repository index and default embedding model run locally. A local chat model can consume the MCP tools through an MCP-capable host; without MCP tool calling, the host must inject CLI/HTTP results manually.

## Optional AI extraction

Normal indexing never calls an LLM. Optional business interpretation is explicit:

```bash
MEMORY_AI_EXTRACTOR_URL=http://127.0.0.1:8080/extract \
pnpm memory ai-extract company.web.next --file=src/app/page.tsx
```

Only supported types above the confidence threshold and with an exact, verifiable source quote are stored. AI memories remain labelled as inferred and are invalidated when their evidence changes.
