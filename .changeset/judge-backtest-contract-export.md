---
"@mcpjam/sdk": patch
---

`@mcpjam/sdk/contract` now exports `judgeBacktestRequestSchema` and the `JudgeBacktestRequest` and `JudgeBacktestReport` types. Before, the schema had no public entry point and the two types came only from `@mcpjam/sdk/platform`, which still exports them. Nothing was removed or renamed.
