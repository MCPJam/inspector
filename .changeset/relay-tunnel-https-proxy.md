---
"@mcpjam/inspector": patch
---

Tunnels now connect through `HTTPS_PROXY` (either case) when it is set, and honor `NO_PROXY`, so an Inspector on a network that only allows outbound traffic through a proxy can open a tunnel. With only `HTTP_PROXY` set, the tunnel uses that. Loopback addresses always connect directly. Without proxy settings, tunnels connect as before.
