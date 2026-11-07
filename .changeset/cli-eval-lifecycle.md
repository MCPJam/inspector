---
"@mcpjam/cli": patch
---

`eval run --wait` and `eval gate` decide when a run has finished from the SDK's shared eval run lifecycle, so they require the `@mcpjam/sdk` release that exports it.
