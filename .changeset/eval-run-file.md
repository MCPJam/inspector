---
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

`mcpjam cloud eval run --file` uploads a versioned suite file (declared identity, provenance, case sync) and starts a run. `eval create --file` on a suite file now points at `eval run --file`. File-owned suite export writes `suite.id` from the declared id.
