---
"@mcpjam/cli": minor
---

`mcpjam compat` now fetches the live host-compat catalog (silent bundled fallback), reports `catalogSource`/`catalogVersion` in the structured result, and adds `--offline` (zero MCPJam network) and `--catalog-url` flags. Verdicts pick up backend catalog publishes without a CLI release.
