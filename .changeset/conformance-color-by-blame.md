---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Conformance: a check that could not run now costs a point only when the server is to blame. No login, a rejected login, a picked tool that is not listed or makes no task, and arguments the tool's own schema rejects show as gray "Not run" with a plain fix. Completion, Name header, task cancel and graceful close show as "Not applicable" when there is nothing to test. A check skipped because an earlier one broke now names that check.
