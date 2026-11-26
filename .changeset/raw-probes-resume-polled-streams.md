---
"@mcpjam/sdk": patch
---

On a 2025 server that hands an SSE answer to polling, the protocol checks now call the server back for the answer instead of grading an empty stream. Invalid Method Error no longer fails such a server, and Functional SSE Streams now grades the real answers.
