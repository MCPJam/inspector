---
"@mcpjam/sdk": patch
---

Stop an empty system prompt from failing every generation. A saved MCPJam client with no system prompt reads as `""`, and `runWithClient` passed it straight to the provider; Anthropic refuses an empty system block with `system: text content blocks must be non-empty`, so every case in the suite failed with a bare "Bad Request". `HostRunner` now treats an empty configured prompt as "none given" and uses its default, the same as it already did for a host snapshot.
