---
"@mcpjam/sdk": patch
---

Fix `stableStringifyJson` determinism: sort object keys by code-unit order
instead of `localeCompare()`, which is host-locale-dependent and can reorder
non-ASCII keys across environments — undermining the function's stable-output
guarantee. ASCII keys (the overwhelming majority) are unaffected.
