---
"@mcpjam/inspector": minor
---

### `@mcpjam/inspector`
- **Master "MCP App" advertisement toggle in the Apps tab**: new switch at the top of the SEP-1865 spec-bridge matrix that controls whether the simulated host advertises the MCP UI extension at all. Off = `clientCapabilities.extensions["ui/mcp"]` is removed entirely, matching a host that doesn't speak MCP Apps (`app.*` calls fall to their feature-detected no-op path). On = the extension is restored to the SDK default (`getDefaultClientCapabilities()` → `mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE]`). Sibling `extensions.*` keys are preserved when present; an emptied envelope is dropped entirely so `appsToJson` / `applyJsonToDraft` and the JSON editor agree on the same shape (no hidden `extensions: {}` round-trip drift).
- **Overrides are preserved across the master toggle**: turning advertisement off leaves any configured `mcpAppsOverrides` / legacy `hostCapabilitiesOverride` dormant on the draft, so toggling back on restores the user's prior per-dimension matrix. "Reset" remains the explicit destructive action that clears both override paths.
- **Per-dimension matrix collapses into a disclosure** when advertisement is on, and is hidden entirely when off — the "Overridden" badge per row and the dormant-overrides note when toggled off both surface the override state without forcing the dimension grid open. Two follow-up commits prune the inline "Preset: …" sublines and reset-button affordance to keep the row body honest about what the matrix can change vs. what's controlled by the toggle.
