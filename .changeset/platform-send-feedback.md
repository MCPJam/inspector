---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add `send_feedback`: one way to tell the MCPJam team about MCPJam itself (a bug, a missing capability, something confusing) at the moment you hit it. The text is sent to the MCPJam team (outside your organization) and kept for 180 days; it is stored in MCPJam's own database and never published.

- `POST /api/v1/feedback` takes `{ kind, summary, details?, operation?, requestId?, errorCode?, projectId? }` and answers `201 { id, receivedAt, duplicate }` once the report is stored. An identical report within a day comes back as `duplicate: true` instead of being filed twice. Guests get `401`; a project you can't see is `404`; reusing an idempotency key for different content is `409`; bursts get `429` with `Retry-After`.
- The idempotency key (`Idempotency-Key` or `x-mcpjam-idempotency-key`) is validated strictly on this route: an empty or over-long header, or two headers that disagree, is a `400` rather than silently ignored.
- SDK: `PlatformApiClient.sendFeedback()`, the `sendFeedbackOperation` (`risk: "exposure"`, no default project), and the `PlatformFeedbackReceipt` / `PlatformFeedbackRequest` / `PlatformFeedbackKind` types.
- MCP: the `send_feedback` tool (idempotent, `openWorldHint: true`). An `INTERNAL_ERROR` or `FEATURE_NOT_SUPPORTED` from another tool now suggests reporting it with its request id, but never for gateway failures, other client errors, anonymous sessions, or a failing report itself.
