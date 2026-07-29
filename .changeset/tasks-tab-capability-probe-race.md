---
"@mcpjam/inspector": patch
---

Stop the Tasks tab sticking on "Tasks not supported" when the capabilities
probe races the connect.

The probe fails closed to `wire: "none"` against a server that is still
connecting, and the fetch was keyed only on server identity — so a probe that
landed before the connection came up left the tab permanently claiming the
server has no tasks support. The effect is now keyed on the connection status
too, re-probing once the connection is actually up (and again after a
reconnect).

A probe that THROWS (network, auth, connect race) is also no longer conflated
with a server declaring no tasks support: it renders a retryable error state
instead of a false "Tasks not supported".
