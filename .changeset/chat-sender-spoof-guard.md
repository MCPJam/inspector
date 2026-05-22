---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Reject spoofed `senderUserId` on shared chat persistence**: the incoming UI transcript is client-controlled, so `stampSenderUserIdsOnSessionMessages` now only trusts the extracted `senderUserId` when it matches the server-authenticated principal for the request (`c.var.requestLogContext.userId`). A collaborator who hand-crafts a message with `metadata.senderUserId: "u-bob"` no longer gets that id stamped onto the persisted Convex trace — the per-message avatar on the saved session reflects who actually sent the message according to the auth context, not whoever the client claims sent it.
- **Wired through all three chat dispatch paths** in `server/routes/mcp/chat-v2.ts` (MCPJam free model, org provider runtime, web direct), each of which calls `stampSenderUserIdsOnSessionMessages` with the resolved `authenticatedUserId`. New `chat-v2.hosted.test.ts` case covers the spoof-rejection contract end-to-end; `chat-ingestion.test.ts` covers the unit-level helper.
- **Helper extraction**: new `normalizeSenderUserId` collapses the two prior copies of "string and non-empty" validation in `readSenderUserId`.
