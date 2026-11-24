---
"@mcpjam/inspector": patch
"@mcpjam/evaluators": minor
---

Hosted eval runs now write a score row for each check that could already fail an iteration without one: tool errors in the trace or in pinned steps (`platform:toolExecution`), an iteration that stopped early (`platform:iterationError`) and scripted widget checks (`platform:widgetCheck`). An iteration's rows now show why it failed, and they give the same pass/fail as the runner's verdict.
