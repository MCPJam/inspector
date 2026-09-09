---
"@mcpjam/inspector": patch
---

Require a bearer token on `POST /api/web/audio/transcriptions`. The route was the only MCP-operation family mounted without `bearerAuthMiddleware`, and its handler answered a credential-less request by fetching a server-side guest session and spending MCPJam's own credential on OpenAI Whisper. It now carries the same bearer + guest-rate-limit mount as its siblings, forwards only the caller's own bearer, and refuses anonymous callers with the same `401` `/tools/list` returns. The per-request body cap drops from 25MB to 10MB — sized to 180s of uncompressed WAV, the largest payload the recorder can produce — because on a per-audio-minute billed API the request size is the request's cost.
