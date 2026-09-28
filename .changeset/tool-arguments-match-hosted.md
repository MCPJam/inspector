---
"@mcpjam/inspector": patch
---

Hosted runs grade the new `toolArgumentsMatch` assertion — every pattern within one call, with `min`/`max` counting matching calls — through the same evaluator the SDK uses, and file its failures at the Tool call stage.

Authors add it from the step picker and the Add drawer as "Tool arguments match pattern(s)": pick the tool and optionally one argument, list up to eight patterns (each checked live against re2js, so a lookahead or backreference is refused as you type), toggle Ignore case, and set the matching-call count under More options.
