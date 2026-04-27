---
"@mcpjam/inspector": minor
---

Add `@cfworker/json-schema` as a direct dependency. It is an optional peer dependency of `@modelcontextprotocol/client@2.0.0-alpha.2` but is required at runtime, so production installs (`npm ci --legacy-peer-deps`) were crashing on startup with `ERR_MODULE_NOT_FOUND`.
