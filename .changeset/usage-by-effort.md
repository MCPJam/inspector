---
"@mcpjam/inspector": patch
---

Usage and cost by effort. The organization usage card groups requests by model × reasoning effort ("claude-sonnet-4-5 · High", "Default" when none was sent) with a Reasoning tokens tile, and eval run metrics show effort, cost and reasoning tokens per target. Direct chat turns and eval iterations now carry `reasoningTokens` and `cachedInputTokens` end to end.
