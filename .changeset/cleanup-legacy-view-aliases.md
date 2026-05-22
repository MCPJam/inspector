---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **Stop sending `outputTemplate` + `serverInfo` legacy aliases to `createMcpView`**: `useSaveView` no longer forwards the input-only `outputTemplate` and `serverInfo` fields when persisting a view through `mcpAppViews:create`. The canonical `resourceUri` (from `getUIResourceUri()` in `part-switch.tsx`) is the single source of truth for what gets saved; the backend normalizer was validating `outputTemplate` whenever it was supplied even though `resourceUri` always won precedence, so the previous code path conditionally elided non-`ui://` OpenAI templates to avoid validation failures. With the aliases removed, that conditional and its `liveOutputTemplateIsUi` derivation are gone.
- `viewOriginProtocol` documentation-only provenance field is unchanged.
