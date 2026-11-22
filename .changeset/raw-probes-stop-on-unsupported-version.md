---
"@mcpjam/sdk": patch
---

The protocol checks that open their own 2025-era session stop when the server answers `initialize` with a protocol version MCPJam does not support. They used to keep sending requests on that session and could report the checks as passed. Invalid Method Error, Multiple POST Streams, Functional SSE Streams, Notification POST Accepted and GET Stream Or 405 now show "could not run" with the version the server picked.
