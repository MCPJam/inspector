---
"@mcpjam/sdk": patch
---

The `chatgpt` host template, and the bundled host catalog fallback, carry ChatGPT's App context budgets in `mcpProfile.apps.modelContextPolicy`: 2,548,000 bytes per update, 256 blocks and 8 MiB per turn. The update budget sits just under what ChatGPT web takes in one request; the other two are MCPJam guardrails. A ChatGPT client seeded from the SDK now admits plugin App context up to that size instead of MCPJam's defaults. Other templates are unchanged.
