---
"@mcpjam/cli": patch
---

`mcpjam tunnel` shutdown revokes the grant by calling the close endpoint directly with the project ID already resolved at startup, instead of going through the `close_tunnel` operation's project re-resolution. This removes a `listProjects` round-trip from the 5s revocation grace window and an independent failure mode where a listing hiccup could skip a revocation that would have succeeded.
