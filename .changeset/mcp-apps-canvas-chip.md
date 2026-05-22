---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **`app.*` chip in the canvas view-iframe injected-globals strip**: surfaces the SEP-1865 MCP Apps spec-bridge override state alongside the existing `window.openai` chip. Reads "from preset" when the user hasn't touched the matrix, or "custom (N overrides)" when `mcpProfile.apps.mcpAppsOverrides` has sparse keys. Clicking the chip routes to the Apps Extension tab (same destination as the `window.openai` chip). The two chips are independent — `window.openai` and `app.*` represent different surfaces and never cross-gate. Tooltip on the `app.*` chip explains the spec bridge is the primary protocol surface (always present, no injection toggle).
