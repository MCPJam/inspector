---
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

`mcpjam cloud eval run --file` uploads a versioned suite file (declared identity, provenance, case sync) and starts a run. `eval create --file` on a suite file now points at `eval run --file`. File-owned suite export writes `suite.id` from the declared id.

Case sync distinguishes the two ways a case stops running: one the file no longer declares is deleted from the hosted suite, while one the file still declares as `disabled: true` keeps its hosted history and is only left out of the launch.
