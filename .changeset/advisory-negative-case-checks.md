---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

An advisory `toolCalledWith` no longer stops a negative case from loading in `evalTestFromPlatformCase` (and so in `mcpjam test` and `@mcpjam/vitest`) when it comes from a step, the case's checks, or the suite's. An advisory check only warns, so it cannot contradict a case that passes with no calls; the same rule already applied to `toolInputMatches` and `toolResultMatches`. The case scorecard's "contradicts a negative case" warning now skips advisory checks of every kind, including `toolCalledAtLeastOnce` and `firstToolWas`.
