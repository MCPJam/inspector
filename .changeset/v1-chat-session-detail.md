---
"@mcpjam/inspector": patch
---

Add `GET /v1/chat-sessions/{sessionId}` (paged, scrubbed transcript) and `GET /v1/chat-sessions/{sessionId}/trace` (incremental inlined spans). Blob URLs never leave the gateway.
