---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Fix `mcpjam xaa run --registration cimd` failing with `Invalid IP address: undefined` on Node 20+.

The SSRF-hardened CIMD document fetch (`fetchPinnedPublicDocument`) pins DNS through a custom `lookup` function, but always answered with a single address string. With `autoSelectFamily` (the Node ≥ 20 default) the socket invokes the lookup with `all: true` and requires an array of `{address, family}` entries, so every CIMD fetch — public and confidential (`--client-auth private-key-jwt`) — died before any request was sent. The lookup now honors `options.all`; every resolved address is still validated against the private/reserved-range blocklist in both callback shapes.
