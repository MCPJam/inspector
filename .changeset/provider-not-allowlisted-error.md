---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Explain a model whose provider is not enabled on MCPJam's hosted gateway.

The error catalog gains `provider/not_allowlisted`. The backend `/stream` code `provider_not_allowlisted` now maps to it instead of `provider/auth_error`, so chat and swarm sessions say the provider is not enabled on MCPJam's hosted gateway, that retrying or changing your API key will not help, and suggest another model or your own provider key.
