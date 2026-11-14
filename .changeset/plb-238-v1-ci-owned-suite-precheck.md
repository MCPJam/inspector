---
"@mcpjam/inspector": patch
---

The v1 API now refuses configuration writes to a CI-owned suite before calling the platform, with the same `409 CONFLICT` / `CI_OWNED_SUITE_READ_ONLY` response as before. A `--file` sync carrying `declaredSuiteId` is unaffected. Expected refusals no longer surface as backend errors in Sentry.
