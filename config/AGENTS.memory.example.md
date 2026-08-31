## Frontend Engineering Memory

- Before scanning source broadly, use the `frontend-memory` MCP server.
- Use `memory_repository` for repository inventory/profile and `memory_route` for route inventory or one exact route.
- For dependency, flow, impact, debug, implementation, verification, change-review or open-ended questions call `memory_context` once with `maxChars: 8000`.
- Follow `answerContract`: cite facts, qualify derived relations as static analysis, and label inferences explicitly. Open only `answerContract.sourceFallback` files when uncertainty remains.
- For historical truth pass an indexed `atSha`; add `compareToSha` only for behavior diff. Never treat an arbitrary, unindexed Git commit as an indexed snapshot.
- Answer architectural “why/rationale” questions only from an approved decision record. Source code can explain what/how, never why it was chosen.
- Never load the SQLite database, all memories or the whole repository into model context.
- Compare `lastIndexedSha`/`snapshotSha` with the relevant Git snapshot when freshness matters. If they differ, report that memory needs sync before treating it as current.
- Treat `inferred`/AI memories as interpretations that require their cited evidence; deterministic facts remain source-backed but may still be conservative static analysis.
