---
"@mcpjam/inspector": patch
---

Tier B Phase 3a (in-place DI): invert the MCP Apps widget modal's remaining
inspector app-state reads. `mcp-apps-modal.tsx` no longer calls
`useActiveMcpProfile` / `useWebManagedServers` / `resolveHostInfo` or reaches
into `@/stores` — the resolved `hostInfo` and `webManagedServers` flow down as
props from the renderer (which already computes them via `useWidgetHost()`), and
the pure `extractMethod` parser + `CspMode` type come from the `WidgetHost`
contract module. This removes the last app-state island in the widget renderer
cluster ahead of the React relocation. No behavior change.
