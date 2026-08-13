---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Say which protocol version a server refused, and offer the setting that fixes it.

A connection pinned to a modern protocol version needs the server to advertise it via `server/discover`, and in pin mode there is deliberately no fallback — the pin exists to reproduce one specific client's wire behavior. When the server doesn't offer it, the upstream client raises `SdkError(EraNegotiationFailed)` naming the version it wanted. The manager then tried the SSE transport, that failed too (a modern-only server answers `405`), and both failures were folded into one message: "Failed to connect to MCP server … using HTTP transports … SSE error: Non-200 status code (405)." What reached the user described the SECOND attempt's symptom. The version was never mentioned, so a user whose client profile pins the latest revision against a server that hasn't adopted it was told their server was unreachable — with no hint that the cause was a dropdown.

The manager now recognizes that case and throws `ProtocolVersionPinUnsupported`, carrying `serverId` and `protocolVersion` as fields and naming both in its message. The version is read from the resolved config, never parsed out of the upstream prose: the manager is what chose the pin, and an upstream reword must not be able to empty the field. Pin mode is detected through `resolveVersionNegotiation` — the same helper the negotiation telemetry uses — so an `auto` connection, which probes and falls back on its own, can never produce this error. Both HTTP exits raise it, including the `disableSseFallback` path, which is where modern-only servers are most likely to land.

`describeError` resolves it to a new slug, `sdk/protocol_version_pin_unsupported`, whose origin is `user_config`. That matters beyond copy: the previous classification was `transport/fetch_failed` (`ambiguous`), so on hosted chat this failure was attributed to MCPJam and paged the team for a version pin. Its catalog entry says what to do — set the version to Automatic, or pick one the server advertises.

In the inspector, the chat banner now renders **Change protocol version**, which opens that client's MCP Protocol tab (`/hosts/:hostId?hostTab=protocol`, via a new exported `buildHostFocusTabPath`). It deliberately replaces the retry rather than joining it: the pin is stored, so resending the identical turn fails identically until someone changes the setting — the opposite of the upstream-error-page case next to it, where resending IS the fix. When the surface has no host id (chatbox, environment), the link degrades to the clients list rather than building a path the `:hostId` route rejects.

The chat surfaces recognize the failure by a clause in the message, because that is all that survives: the AI SDK collapses a failed response into `new Error(await response.text())`, so the class, the `normalized` block and the response headers are gone by the time a banner sees anything. Both sides pin the clause in tests, and the SDK-side test names the inspector files to update if the wording changes.
