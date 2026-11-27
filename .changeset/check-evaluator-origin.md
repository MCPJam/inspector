---
"@mcpjam/sdk": minor
"@mcpjam/evaluators": minor
---

A check can record which library evaluator it was added from, as `evaluator: { id, version }` beside `role` and `severity`. Suite files accept it, and it does not change a check's criterion id, so a check added from the library shares its score history with the same check written by hand.

`toolResultMatchesSchema` also accepts `schema: "declared"`, which checks each result's `structuredContent` against its tool's declared output schema. With complete evidence, it skips tool errors and results from tools without output schemas. It reports Not applicable when no in-scope result qualifies and no schema rejection was recorded.
