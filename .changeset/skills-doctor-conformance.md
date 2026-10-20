---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

`server doctor` reports a skills server that omits the `ttlMs` and `cacheScope` the stable Skills extension spec requires on `skills/list` and `skills/get`, or that declares the extension without the `resources` capability.
