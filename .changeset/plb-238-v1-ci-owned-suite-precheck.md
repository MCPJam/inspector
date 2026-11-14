---
"@mcpjam/inspector": patch
---

The v1 API now refuses configuration writes to a CI-owned suite before calling the platform, with `409 CONFLICT` and `details.reason: "CI_OWNED_SUITE_READ_ONLY"`, so expected refusals no longer reach Sentry as backend errors. `cases/generate` and `cases/import` answer that 409 before connecting the suite's servers, where they returned 502. `POST /eval-runs` answers it before connecting when the launch would rewrite the suite; reruns still run. A PATCH with nothing to change now gets 409 instead of 200. A `--file` sync carrying `declaredSuiteId` is unaffected.
