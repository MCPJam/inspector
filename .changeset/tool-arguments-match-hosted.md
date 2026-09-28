---
"@mcpjam/inspector": patch
---

Hosted runs grade the new `toolInputMatches` and `toolResultMatches` assertions — every pattern within one call or one result, with `min`/`max` counting matching calls or results — through the same evaluator the SDK uses. Input failures file at the Tool call stage and output failures at Response.

Authors add them from the step picker and the Add drawer, the output check as "Tool output matches pattern(s)": pick the tool (required for input; output can read any tool) and optionally one field by path, list up to eight patterns (each checked live against re2js, so a lookahead or backreference is refused as you type), toggle Ignore case, and set the matching count under More options.
