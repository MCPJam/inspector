---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Hosted conformance runs can be read check by check. `get_conformance_check` (`GET /api/v1/projects/:projectId/conformance-runs/:runId/checks/:checkId`, `mcpjam cloud conformance check`) returns one check with its stored evidence, each of `details` and `output` capped at 16 KB. Run history and a finished run's failing checks page with `cursor` and `nextCursor`. `mcpjam cloud conformance run`, `runs`, `status`, `report` and `check` take a hosted run from start to evidence, and the hosted MCP server serves the conformance tools.
