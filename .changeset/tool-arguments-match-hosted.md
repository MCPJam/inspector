---
"@mcpjam/inspector": patch
---

Hosted runs grade the new `toolArgumentsMatch` assertion — every pattern within one call, with `min`/`max` counting matching calls — through the same evaluator the SDK uses, and file its failures at the Tool call stage.
