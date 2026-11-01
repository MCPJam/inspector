---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance: Server Initialize now reports how long the initialize handshake took instead of 0ms, including when the connect fails. The Conformance page no longer shows a "0ms" duration on checks that were skipped.
