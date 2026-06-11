---
"@mcpjam/sdk": patch
---

`PlatformApiClient` body handling hardened: empty success bodies (204) resolve to `undefined` instead of throwing `INTERNAL_ERROR`; error responses with empty or non-JSON bodies (bare 429s, proxy HTML) now map through the standard error path with `Retry-After` preserved and the code derived from the HTTP status when unambiguous (401/403/404/429). The platform runtime-safety guard now also scans the built `dist/platform` bundle, covering the entire first-party transitive closure (e.g. `SdkError`) rather than only `src/platform`.
