---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Enforce `toolPolicy` on harness evals, at the MCP proxy.

A harness run has no in-process tool loop to wrap: the real runtime calls MCP
itself, from its own sandbox, against the generated `.mcp.json`. So the policy
was previously refused at launch. It now travels to the one place every harness
MCP call does pass through — MCPJam's own proxy — resolved at launch into a
decision table by the same shared contract the in-process gate uses, and sealed
(AES-GCM, key derived from the secret the proxy token already requires)
_together with_ the proxy credential. The sandbox holds one opaque value, so
removing the policy from `.mcp.json` removes access rather than producing an
unpoliced run.

A denied `tools/call` is blocked before the upstream call, answered as a
successful MCP result carrying a block marker, and accounted back onto the
iteration as the same `policyBlocks` the in-process gate produces —
`notMeasured` + `blockedByPolicy`, never a failure attributed to the customer's
server. `tools/list` is still unfiltered (denied tools stay visible but
blocked), a tool that appears only after launch is denied, and a policied
harness run is still refused at launch on a deployment that cannot seal.
