---
"@mcpjam/sdk": patch
---

A protocol run pinned to a version the server does not speak now stops instead of failing the server for it.

- When the MCP connection is refused because the server does not support the pinned version, every selected check shows "could not run" with one message naming the version to run instead. The raw checks and the advice probes do not run.
- When the server answers `initialize` with a version MCPJam speaks but the run does not use (for example a run pinned to 2025-11-25 against a server that only speaks 2025-06-18), the five checks that open their own 2025-era session stop after `initialize`: Invalid Method Error, Multiple POST Streams, Functional SSE Streams, Notification POST Accepted and GET Opens SSE Or Returns 405. They used to go on sending the run's version, and the server's 400 failed them.
- These "could not run" rows count like a missing login: they cost no points, and the run stays incomplete.
- The DELETE that closes the session, and the one behind the Explicit Session Termination advice, now carry the version the server answered with. That advice is no longer given when the server answered with another version, so a 400 to the pinned version is not blamed on the server.
