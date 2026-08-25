---
"@mcpjam/inspector": patch
---

`toolCallId` is now part of the runner's tool-call type instead of a cast, so the eval persistence boundary is type-checked again.

Tool-policy enforcement gave the runner a reason to carry the provider's `toolCallId` on every extracted tool call — `extractToolCallsExcludingPolicyBlocks` matches blocked calls by it. The field was attached with an `as ToolCall` cast at all three push sites, and `type ToolCall` was never widened to admit it. That cast is precisely what suppressed TypeScript's excess-property check, and the same array is what gets persisted as `updateTestIteration.actualToolCalls` — where a Convex object validator that had never heard of `toolCallId` rejected it outright. Every eval iteration that called a tool failed to record its result; only prose-only iterations, which send `[]`, got through.

This change is type-only and alters no runtime behavior — the runtime fix is the matching backend widening, which has to deploy first. What it buys is that the boundary can't silently drift again: `ToolCall` and `finalize-iteration`'s `ToolCallRecord` now both name `toolCallId`, the three casts are gone, and adding another undeclared field to a persisted tool call is a compile error rather than a production `ArgumentValidationError` that surfaces sixty seconds later as `Worker heartbeat lost`.
