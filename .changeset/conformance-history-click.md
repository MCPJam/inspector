---
"@mcpjam/inspector": patch
---

Stop creating a new conformance history row when opening an existing run.

The live panel persisted on the idle mount/reset bump, so remounting it —
including clicking a run in history — wrote Incomplete 0s UI rows the operator
never started.
