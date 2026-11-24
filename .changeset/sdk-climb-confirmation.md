---
"@mcpjam/sdk": minor
---

New platform operation `confirm_climb` and its `confirmClimb` client method: the one-time confirmation of a stopped climb, two run groups on the cases no round ran, with a 95% interval on the difference found by resampling cases (`confirmationInterval`, fixed seed, computed on read). `stop_climb` now returns a `summary` that labels the steering and validation results as the cases that picked the result and states what the climb established and what it did not. `mcpjam cloud climbs confirm` is the CLI command.
