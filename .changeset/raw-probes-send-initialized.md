---
"@mcpjam/sdk": patch
---

The protocol checks that open their own 2025-era session now send `notifications/initialized` right after `initialize`, as a client must, before any other request. A server that refuses requests until that notification arrives used to be failed by Invalid Method Error for a refusal MCPJam caused. Notification POST Accepted grades the notification the handshake sent, so it still goes out once per session.

The handshake now gives one verdict that every one of those checks reads. When `initialize` is answered with an error (a JSON-RPC error on HTTP 200 included), on another version, or the notification cannot be delivered, the checks that would send more requests on the session say "could not run" with the same reason instead of probing a session that is not ready. Only the notification Notification POST Accepted grades enters the wire record, so one bad answer to it is listed once. An `initialize` refused because the server does not speak the run's version is a setup gap for every one of those checks: no points lost, and the message names a version to run on.

A 2026-era pinned run with no client check now asks the server once with `server/discover` before the raw checks. If the server refuses the pin (`-32022`, or a 2025 server's `400` with `-32000`), every selected check says "could not run" as a setup gap, the same as when the client connection is refused for the pin, and no raw probe is sent.
