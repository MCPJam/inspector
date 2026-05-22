---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Simplified Apps extension matrix UI**: the `McpAppsCapabilityMatrix` body now uses a single flat dimension list with per-row metadata (label + description shown on hover) instead of the previous "main vs. advanced" split disclosure. The two dimension arrays (`MCP_APPS_MAIN_DIMENSIONS` / `MCP_APPS_ADVANCED_DIMENSIONS`) collapse into one `MCP_APPS_DIMENSIONS` typed by `McpAppsDimensionKey` with a single `McpAppsDimensionMeta` record per row.
- **Tighter "Overridden" affordance on both matrices**: the per-row sublines on the `window.openai` capability matrix drop the redundant "Preset: <value>" text and keep only the orange "Overridden" badge — the preset value is already visible as the row's effective state when the user hasn't diverged. Same simplification applied to the `app.*` spec-bridge matrix rows.
- **Canvas client capability chip parity**: `ClientCapabilityMatrix` and `canvasBuilder` updated so the canvas-side surface stays in sync with the simplified matrix shape; 1 new `RedesignedClientCanvas` test asserts the chip reflects the matrix state.
- **No behavior change to the underlying override**: same `mcpAppsOverrides` sparse merge, same preset baselines, same JSON editor round-trip. Visual/structural refactor only.
