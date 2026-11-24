---
"@mcpjam/sdk": minor
---

New `@mcpjam/sdk/climbs` entry: the pure functions over a climb's results. `suiteCheck` reports whether a suite can show a change, `climbForOptions` lists what a climb can be for with a number and up to three failed runs behind each, `whatCanChange` ranks everything a mock can change on a server with who reads each field, `refuseUnreadChange` refuses a round that changes only what no client of the climb reads, and `climbPrompt` writes the kept changes for the agent that works on the server's code. `get_climb` returns the first three, `get_mock_server` the ranked list, and `stop_climb` the prompt.
