---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Agents and the CLI can read a run's tool routes from the persisted row

**The page already computed routes locally; a foreign-project 404 and the MCP tool need the same document the materializer writes.** `GET /projects/:p/eval-runs/:r/route-facts` serves the materialized `EvalRunRouteFacts` document. The platform client, MCP operation, and `cloud eval route-facts --run` all read that row. A 404 after the run itself was retrieved is unmeasured, never reconstructed in the SDK client. The evaluate run page prefers the persisted document and falls back to the existing client producer when the row is absent.
