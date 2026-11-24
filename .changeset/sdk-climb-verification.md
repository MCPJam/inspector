---
"@mcpjam/sdk": minor
---

New platform operation `verify_climb` and its `verifyClimb` client method: after the kept changes are applied to a server's code, it checks the server's listing against each kept change (applied, missing or different), then runs the server beside a mock that puts the old values back and records the commit. `@mcpjam/sdk/mocks` gains `inverseOfChanges`, which builds that mock, and `@mcpjam/sdk/climbs` gains `checkKeptChanges` and `verificationReport`. The `x-mcpjam-ci` header the client sends now carries `dirty`. `mcpjam cloud climbs verify` is the CLI command.
