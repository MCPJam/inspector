---
"@mcpjam/sdk": minor
---

New platform operations `submit_climb_round`, `get_climb_round`, `set_climb_round_decision` and `stop_climb`, with the matching client methods. A round measures one saved server (usually a mock) against the best so far in every environment of a climb, on the steering and validation cases only; `get_climb_round` can hold the call, up to 50 seconds, until the round settles. `mcpjam cloud climbs rounds submit|get|decide` and `climbs stop` are the CLI commands.
