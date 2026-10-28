---
"@mcpjam/evaluators": minor
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A tool call that failed and was then made again with the same arguments now counts as one call. `evaluateToolCalls` grades the failed attempt as part of its retry: it is never an extra under `maxExtraToolCalls`, and it takes no position under `toolCallOrder: "strict"`. Two successful identical calls still count as two. Mark a failed actual call with `failed: true` (or use `markFailedToolCalls` with the run's tool errors); the result lists each retried attempt in the new `retries` field, and `findToolCallRetries` returns the same list on its own. Inspector eval runs read failures from the run's trace, record the retries on each turn's trace summary, and show them as "retried" in the tool-call diff instead of "unexpected".
