---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add the post-negotiation capability re-resolution seam (`eraCapabilities.modern`),
and use it to declare url-mode elicitation on auto-negotiated modern connections.

Client capabilities are resolved at connect time, before era negotiation has
run, so the base set must be honest under the most conservative era the
connection could land on. That forced auto-negotiated (Client default)
connections to under-advertise on 2026-07-28: url-mode elicitation — which the
local MRTR bridge fully fulfils — stayed undeclared because the connect-time
resolver could not rule out a legacy landing, so every url-mode `input_required`
round died at the server's mode-aware capability gate (`-32021`) unless the
user explicitly pinned the protocol version.

`MCPServerConfig.eraCapabilities.modern` is a merge-style capability overlay
the manager applies exactly once, immediately after era classification, when
the connection lands on a 2026-era revision. The 2026 wire re-declares
capabilities on every request's `_meta` envelope (the upstream client stamps it
from the live set), so the widened declaration flows outward from the next
request on and then stays stable for the connection's lifetime — MRTR rounds of
one logical operation always see one consistent set. Legacy landings never
apply the overlay (their `initialize` already carried the conservative base:
fail-closed), exact `clientCapabilities` pins ignore it entirely, and the
overlay's `elicitation` key is subject to the same advertise=enforce gate as
the runtime-added one.

The Inspector's local MRTR helper (`withLocalMrtrElicitationCapability`) now
rides the seam instead of guessing "provably modern" from the pin and the
accept-list — a predicate that had to answer "no" for the common unpinned
connection. url-mode elicitation (`open-dashboard`-style tools) now works on
Client-default connections that auto-negotiate onto 2026-07-28.
