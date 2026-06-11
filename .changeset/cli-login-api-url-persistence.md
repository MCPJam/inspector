---
"@mcpjam/cli": patch
---

`mcpjam login` now stores the API base URL it was run against, and cloud commands using the stored login default to that deployment instead of prod. An invalid `--api-url` / `MCPJAM_API_URL` is a hard usage error rather than a silent fallback to prod, and rotated token expiries are computed from the injected clock.
