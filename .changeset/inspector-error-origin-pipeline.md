---
"@mcpjam/inspector": patch
---

Make #mcpjam-alerts trustworthy: page on MCPJam's failures, and only those.

Server error envelopes now ask one question — whose fault is this? — and act on the answer. `origin: "mcpjam"` captures to Sentry; everything else is recorded in Axiom (`http.request.failed` carries `origin` and `slug`) without paging, so the volume of each bucket is measurable before anything is promoted into the alerting path.

This closes a structural blindness and a noise problem that were two halves of the same accident. `/api/web/*` never rethrows, so `app.onError -> logger.error -> Sentry` was unreachable for the entire hosted surface and hosted connect 502s were invisible. Meanwhile every catch-site under `/api/mcp/*` called `logger.error`, which captures unconditionally, so a user's dead MCP server — or a conformance probe doing exactly its job — raised an issue and posted to the channel.

Also: chat failures reach the client error sinks at all now (they previously hit a rate-limit filter that no-op'd everything else, so a 502 left no client trace), a non-OK response from MCPJam's own chat backend is classified even though no `Error` object exists at that site, and `ErrorCard` says whether a failure was MCPJam's or not.
