---
"@mcpjam/inspector": minor
---

### `@mcpjam/inspector`
- **Structured matrix UI for the SEP-1865 `app.*` spec bridge in the Apps tab**: clickable surface for the per-dimension override added in #2226. Sits below the existing `window.openai` matrix as a sibling — two independent surfaces, never cross-gated. Layout: `availableDisplayModes` multi-checkbox cluster (always visible), main disclosure with notification gates + `serverResources` / `logging`, and an Advanced disclosure for sandbox sub-fields, resource-meta, `toolInfo`, and the rare advertise rows. "Overridden" badge on rows the user has diverged from the host style preset; "Match host preset" chip clears the entire matrix at once. The matrix invariant (`availableDisplayModes` non-empty) is enforced in the UI by force-enabling `"inline"` when the user unchecks the last mode. Round-trips with `appsToJson` / `applyJsonToDraft` so the JSON editor below stays in sync. 11 new component-level tests cover toggle → sparse override, toggle-back-to-preset → drop key, "Overridden" badge tracking, chip clear, disabled-when-clean, Advanced disclosure visibility, mode cluster edits, and the empty-allowlist coercion.
