---
"@mcpjam/inspector": patch
---

The v1 API now refuses configuration writes to a CI-owned suite up front, with `409 CONFLICT` and `details.reason: "CI_OWNED_SUITE_READ_ONLY"`.

- `cases/generate` and `cases/import` answer that 409 before connecting the suite's servers, where they returned 502.
- `POST /eval-runs` answers it before connecting when the launch would write the suite: inline `tests` without `suiteRerun: true`, or `refreshSnapshot` outside a project environment.
- A suite `PATCH` with nothing to change gets 409 instead of 200, and so does an environment launch with inline `tests` that would save nothing (it got 202).
- A suite the SDK created has no file, so its 409 points to the SDK or a duplicate instead of a suite file, and a `declaredSuiteId` sent to it is refused up front.
- `details.hint` suggests `declaredSuiteId` only where sending it can work.
- A `--file` sync of its own suite is unaffected.
