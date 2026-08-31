## Frontend Engineering Memory

- Before scanning source broadly, use the `frontend_memory` MCP server.
- Use `memory_get_repository` for framework/version/freshness and `memory_list_routes` or `memory_get_route` for exact route questions.
- Use `memory_dependencies` for API, configuration and package questions.
- For open-ended questions call `memory_search` once with `limit: 5` and `maxChars: 8000`. Increase only when the first result set is insufficient.
- Do not call both `memory_search` and `memory_explain` with the same question; they return the same bounded retrieval context.
- Answer from returned facts first. Open only the evidence files listed by the results when implementation detail or verification is still required.
- Never load the SQLite database, all memories or the whole repository into model context.
- Compare `lastIndexedSha` with the relevant Git snapshot when freshness matters. If they differ, report that memory needs sync before treating it as current.
- Treat `inferred`/AI memories as interpretations that require their cited evidence; deterministic facts remain source-backed but may still be conservative static analysis.
