---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

On a run's scorecard, Connection, Discovery, Tool call and Response each start with a built-in runner check whenever the stage analysis measured that stage. The check reports what the runner itself observed there, in the same Expected / Actual form as the evaluators. It fails only for the runner's own reason: the connection failed, listing tools failed, a call never produced a result, or the server reported a tool error. When one of the stage's evaluators failed it instead (an assertion, the argument matcher, a widget check), the runner check says so and stays undecided rather than repeating the failure. A stage that does not apply to the case shows no runner check. A case's own scorecard lists Tool call and Response only when the case gives the runner a call or response to measure.

A runner check wears a **Built-in** badge instead of a role and decides nothing on its own. It is not a score row, so gates and the evaluation config are unchanged.

`STANDARD_CHECKS` gains the two runner checks this needs, `call.completed` ("Tool call completed") and `response.returned` ("Result returned to the model"). The `measuredBy` field of a runner check can now be `"call"` or `"response"` as well as `"connection"` or `"discovery"`.

The settings tables now label runner checks **Built-in** instead of Required. Response gets its runner check too, and a case's own evaluator table describes its match rows with the case's match options rather than the defaults.
