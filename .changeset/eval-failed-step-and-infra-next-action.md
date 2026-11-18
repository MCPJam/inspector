---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

An eval step whose model call or tool call failed is now recorded as failed, with the error as its reason, instead of `ok`. Before, a single-prompt case that hit a provider error showed the error on no step at all. When MCPJam's own infrastructure failed a trial, the decision summary's next action now says what broke (provider unavailable, rate limit, capacity, API key, model settings, sandbox or usage limit) instead of telling you to check a server connection that worked. `NEXT_ACTION_BY_INFRA_CLASS` is exported from `@mcpjam/sdk/contract`.
