---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Apps tab JSON editor surfaces `mcpAppsOverrides`**: round-trip serialize + parse for the SEP-1865 `app.*` spec-bridge sparse matrix override added in #2226. Until the structured matrix UI lands, users can configure the override by hand-editing JSON in the Apps tab — typing `{ "mcpAppsOverrides": { "serverResources": false, "logging": false } }` now persists to `mcpProfile.apps.mcpAppsOverrides` instead of being silently dropped. Soft-validated on parse: boolean rows require booleans, `availableDisplayModes` filters to known modes (`inline` / `fullscreen` / `pip`), and entirely-invalid blocks collapse to `undefined` so the resolver falls back cleanly to the host style preset. Sibling fields (`compatRuntime`, `sandbox`, `uiInitialize`) are preserved across edits. Sparse in serialize: omitted from the JSON when no override is persisted.
