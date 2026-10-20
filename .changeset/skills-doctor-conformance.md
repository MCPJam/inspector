---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

`server doctor` reports a skills server that omits the `ttlMs` and `cacheScope` the stable Skills extension spec requires on `skills/list` and `skills/get`, lists a file without its `size`, or declares the extension without the `resources` capability.
