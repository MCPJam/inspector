---
"@mcpjam/inspector": patch
---

A `toolResultContains`, `toolResultMatches` or `toolResultMatchesSchema` check placed after a `toolCall` step now grades what that call returned. It reads the most recent pinned call of the tool it names, and fails as missing evidence when that call errored or returned nothing, instead of reporting that the call carried no result. `toolResultSizeUnder`, and result checks that name no tool, still read the transcript. `toolCalledAtLeastOnce` and `firstToolWas` now count only the agent's own calls, not the case's `toolCall` steps.
