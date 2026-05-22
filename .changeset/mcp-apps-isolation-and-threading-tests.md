---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Defensive test coverage for the two-matrix architecture + override threading**: 11 new tests across three areas defending the foundation series' contracts. (1) **Cross-matrix isolation source-grep**: asserts `useToolInputStreaming.ts`, `mcp-apps-modal.tsx`, and the `McpAppsCapabilityMatrix` / `OpenaiAppsCapabilityMatrix` component bodies in `AppsExtensionTab.tsx` never reference the OTHER matrix's runtime gate identifiers. When the eventual PR B notification gates land, these tests catch any accidental cross-wiring at PR-review time. (2) **`draftToHostConfigInputV2` carries `mcpAppsOverrides`**: chatbox creation inherits the project default's matrix override through `mcpProfile`, same guarantee as the legacy `hostCapabilitiesOverride` inheritance. (3) **`projectHostConfigRunOverride` carries both override paths**: eval runs project the full `mcpProfile` (and the legacy field) into the per-Run snapshot, so eval traces match what the production host's resolver advertises.
