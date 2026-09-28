---
name: drive-mcpjam-playground
description: Drive an API Playground session through MCPJam's remote MCP tools or cloud CLI, inspect browser evidence, and hand the live session to its owner. Use for agent-driven MCP server debugging with a hosted browser.
---

# Drive MCPJam Playground

Use the public `sessionId` returned by send, show, or browser open. The wire `chatSessionId` and logical `browserSessionId` are read-only metadata. Return minted “Open in Playground” links instead of constructing URLs.

## Session loop

Send a scoped request with `send_chat_message`; inspect `get_chat_session_trace` and `get_chat_session` for the reply, tool results, latency, and usage. A model call is billed on every send. Configuration pins at the first model turn.

Attach a browser only on turns that need it. Initially send `browser: {policy: {mode: "allowlist", originAllowlist: ["https://example.com"]}}` with the origins relevant to the authorized task. Later send `browser: {}` to reuse that grant. `toolMode: "read_only"` additionally restricts browser tools to observation. Host policy remains a ceiling, and the browser grant and starting profile cannot be changed after opening.

Use `drive_chat_session_browser` for open, navigate, act, invoke, note, or close without a model call; use `observe_chat_session_browser` for observe, trace, and artifact. The equivalent CLI group is `mcpjam cloud sessions browser`.

## Handoff and retries

The API-key owner can open the Playground link, take over the live browser, and press “Resume agent.” A `browser_in_use` result means the person still has control. Tell the user, wait for handback, and observe again before taking an action. Do not automatically repeat a click planned before takeover.

Keep the same idempotency key when retrying a send whose outcome is unresolved. A completed key identifies the existing turn. An active key means wait. An unknown post-execution outcome requires reading the transcript and trace; do not generate a new key to repeat a potentially executed action. Keep command IDs stable for the same reason.

## Evidence and desktop lifecycle

Screenshots are URLs in send/trace/observe/artifact responses, not MCP image blocks. `unavailable` and `not_captured` are explicit absence states. Use `cloud sessions browser artifact --session <sessionId> --command-id <commandId> --download <dir>` to save available pixels.

Each live conversation desktop is metered. The default per-user live cap is two across projects; an admin may override it. Close a browser when the authorized work is finished. Sleeping browsers wake on a browsing turn or command; show and trace reads do not wake them. A capacity refusal before execution may be retried with the same key after another browser closes.
