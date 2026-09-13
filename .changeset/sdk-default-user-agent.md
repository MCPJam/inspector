---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Identify the SDK in every platform request, and record the caller's user-agent.

The SDK sent a `user-agent` only when the caller supplied one, and most callers
do not — so the request logs cannot answer "who is on the SDK, and on which
version?". That is not a gap in the telemetry: Axiom carries every request. It
is a field nobody populated, and the cost is that decisions about this surface
get argued from reasoning instead of settled from data.

Outside a browser, `PlatformApiClient` now sends `mcpjam-sdk/<version>` by
default, and the new `DEFAULT_PLATFORM_USER_AGENT` export holds that value.

**This changes what goes on the wire for callers that already set `userAgent`.**
` mcpjam-sdk/<version>` is now appended to the value they supply, so the CLI
sends `mcpjam-cli/5.7.1 mcpjam-sdk/8.7.1` instead of `mcpjam-cli/5.7.1`, and the
MCP worker sends `mcpjam-mcp-worker/0.2.0 mcpjam-sdk/8.7.1` instead of
`mcpjam-mcp-worker/0.2.0`. Any filter that matches the old string exactly, or
anchors it at the end, stops matching. A consumer that bundles the SDK from
source with no version injected reports `mcpjam-sdk/unknown`.

In a browser page (a global `window` and `document`) nothing changes: no default
is sent, and a supplied `userAgent` goes out unchanged. Chromium drops a
script-set `User-Agent`, but Firefox sends it, and a page usually bundles the
SDK from source, so a default there would log browser users as
`mcpjam-sdk/unknown`. Node, Bun, Deno and Cloudflare Workers still send the
default; they have `navigator` but no `document`.

The inspector records the header on its request-log rows, sanitized and capped
at 256 characters. It is a log field and nothing may branch on it: a user-agent
is caller-supplied text, and this server already removed UA-derived attribution
once for exactly that reason.
