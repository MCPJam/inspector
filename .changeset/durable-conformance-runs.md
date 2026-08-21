---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Durable conformance runs: history, CLI upload, and GitHub dual checks

Replace browser-only conformance state with project-owned immutable runs.
`runConformance` / `reportConformanceRun` upload a composite report; `mcpjam
conformance run` defaults to Protocol + Apps + Tasks and prints the UI deep
link. Hosted Inspector keeps a history-first view and shareable read-only
links. GitHub App execution can emit an opt-in `MCPJam Conformance` check
alongside `MCPJam Evals` from the same parent build.
