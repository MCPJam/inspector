---
"@mcpjam/inspector": patch
---

Internal: the pure model behind the Evaluate case scorecard — one case's scorers in chain order, with provenance and join keys, plus the trial joiner that fills them from server facts. Scorer identity moves to `shared/` so the client mints the same criterion ids the server persisted.
