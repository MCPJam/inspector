---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

The hosts page no longer crashes with `Cannot read properties of undefined (reading 'provider')` on a host whose model id is outside the hosted catalog. The backend stores such a host's selection as `{ source: "legacy", modelId }`, without a `fallback`, and the editor's dirty check passed it to `selectionConfigKey`, which read `fallback.provider`. `selectionConfigKey` now accepts a stored legacy selection and keys it as the backend's stored form.
