---
"@mcpjam/cli": patch
---

`tools call` reports `_durationMs` on object-shaped JSON output — wall-clock milliseconds spent in the tool call itself, excluding connection setup, so it measures the same window as the `durationMs` returned by `POST /v1/projects/{projectId}/servers/{serverId}/tools/call`. Array and non-object results are returned unchanged. `--reporter` output keeps its own end-to-end `durationMs` and is unaffected.
