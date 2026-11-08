---
"@mcpjam/inspector": minor
---

A conformance run started through `/api/v1` on a saved server now runs that server's saved conformance settings: its picked checks and advice, and the tool inputs those checks call. Send `settings: "none"` to run every check with no tool inputs, as before. The receipt says which applied in `settingsSource`. Hosted runs also end at their time budget (300 seconds unless saved shorter), stop within one heartbeat of a cancel, refuse an unknown `protocolVersion` with the valid versions, read the `Idempotency-Key` header, and allow 30 starts per user per 10 minutes.
