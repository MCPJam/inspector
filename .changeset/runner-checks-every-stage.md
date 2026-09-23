---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Every stage of a test case's scorecard now shows at least one row. Connection, Discovery, Tool call and Response each start with a built-in runner check that reports what the stage analysis decided for that iteration, in the same Expected / Actual form as the evaluators. A runner check wears a **Built-in** badge instead of a role and decides nothing on its own. It is not a score row, so gates and the evaluation config are unchanged.

`STANDARD_CHECKS` gains the two runner checks this needs, `call.completed` ("Tool call completed") and `response.returned` ("Result returned to the model"). The `measuredBy` field of a runner check can now be `"call"` or `"response"` as well as `"connection"` or `"discovery"`.

The settings tables now label runner checks **Built-in** instead of Required. Response gets its runner check too, and a case's own evaluator table describes its match rows with the case's match options rather than the defaults.
