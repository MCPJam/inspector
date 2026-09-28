---
"@mcpjam/inspector": patch
---

Hosted runs grade the new `toolInputMatches` and `toolResultMatches` assertions — every pattern within one call or one result, with `min`/`max` counting matching calls or results — through the same evaluator the SDK uses. Input failures file at the Tool call stage and output failures at Response.

Authors add "Tool input matches pattern(s)" from the step picker or the Add drawer, and "Tool output matches pattern(s)" from the Add drawer: pick the tool (required for input; output can read any tool) and optionally one argument or field by name, list up to eight patterns (each checked live against re2js, so a lookahead or backreference is refused as you type), toggle Ignore case, and set the matching count under More options.
