---
"@mcpjam/sdk": minor
---

Add a `mcpjam/…` model provider so an eval can run on MCPJam-hosted inference
with no provider key: `model: "mcpjam/anthropic/claude-sonnet-4.5"` bills the
organization's credits and needs only `MCPJAM_API_KEY`. Exports
`releaseMcpjamModelLeases` for suites built by hand; `EvalSuite.run` already
calls it at teardown.
