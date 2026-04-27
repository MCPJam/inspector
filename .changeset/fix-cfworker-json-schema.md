---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Add `@cfworker/json-schema` as a direct SDK dependency. It is an optional peer dependency of `@modelcontextprotocol/client@2.0.0-alpha.2` but is required at runtime, so isolated CLI and SDK installs were crashing on startup with `ERR_MODULE_NOT_FOUND`.
