---
"@mcpjam/sdk": patch
---

Fix materialized multi-prompt eval cases (`evalTestFromPlatformCase`, `buildCorpus`, `loadCorpusFromLock`): every prompt after the first is now sent with the iteration's earlier turns as its conversation `context`, as a hosted run sends them, instead of starting a new conversation per prompt. Each iteration still starts a fresh conversation.

A turn that errors now ends the iteration, as it does hosted: the remaining prompts are not sent, and the iteration is recorded as an execution failure (`failed`, or `timed_out` / `cancelled` when that is what stopped the turn) carrying the turn's error, rather than as a completed iteration whose partial transcript is graded as a task failure.
