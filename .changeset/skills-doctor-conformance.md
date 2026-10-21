---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

`server doctor` reports a skills server that omits the `ttlMs` and `cacheScope` the stable Skills extension spec requires on `skills/list` and `skills/get`, lists a file without its `size`, or declares the extension without the `resources` capability. The skills check is `error` for such a server, the doctor's status is `partial`, and `mcpjam server doctor` exits 1, so a CI step that runs the doctor fails for a server built against the draft spec until it sends the required fields. The skills check also carries its findings as data (`checks.skills.findings`), which the hosted doctor uses instead of its sentence.
