# Suite-start conflict retry validation

Implementation branch: `fix/suite-start-occ-retry`, based on inspector main `704afe37eb`.
Companion fixture branch: `test/suite-start-quota-burst`, based on backend main `9a4e85445`.

The shared suite launcher retries only the failed `startTestSuiteRun` mutation,
with identical arguments, up to four total attempts. The three waits use full
jitter with ceilings of 250, 500, and 1,000 milliseconds. Structured Convex
refusals and ambiguous network failures are not retried. Iteration preparation
and its existing cleanup run outside this retry loop.

## Results — September 24, 2026

- Inspector: 22 focused tests passed (existing recorder tests plus seven retry tests).
- Backend: 31 focused tests passed (starter allowance, iteration quota, generated registry).
- Backend full typecheck passed; fixture lint and formatting passed.
- Retry helper standalone typecheck passed. Inspector full server typecheck has
  524 diagnostics, also present on unchanged main with the same dependencies;
  comparison found no new diagnostic messages. Inspector ESLint configuration
  does not cover these server files.

Live checks used `exuberant-albatross-496`, a fresh organization per scenario,
500 starter iterations, and the enforced free_v1 daily allowance of 75:

| Five simultaneous requests | Accepted | Reserved | Starter used | Daily used |
| --- | ---: | ---: | ---: | ---: |
| 100 iterations each | 5 | 500 | 500 | 0 |
| 115 iterations each | 5 | 575 | 500 | 75 |
| 200 iterations each (5 × 20 × 10 total requested) | 2 | 400 | 400 | 0 |

All successful requests were replayed with their original keys. They returned
the same receipt IDs without increasing usage. Above-limit requests returned
billing errors. All fixture records were deleted. The development iteration-limit
flag was restored to its original absent state and verified afterward; billing
enforcement stayed at 1. Production was not changed.

These live checks use the real quota precheck and reservation helpers plus the
new retry helper. They do not execute full suite launches or model calls. Local
recorder tests cover wiring the retry around the actual suite-start call, including
injected conflicts; the live test does not require naturally occurring retry exhaustion.

## Repeating the live check

The companion backend worktree contains `convex/qaSuiteStartQuota.ts`, an internal
fixture restricted to this exact development deployment. Deploy it using `env.dev`.
From the inspector worktree root, run:

```sh
node_modules/.bin/tsx mcpjam-inspector/scripts/qa-suite-start-quota.ts /Users/nacho/coding/mcpjam/wt-suite-start-quota-burst
```

The script requires the iteration-limit flag to be absent and billing enforcement
to equal 1. It temporarily enables the iteration limit, cleans up fixtures, and
restores the flag in a `finally` block. The backend fixture is test support, not
a required production deployment for the inspector fix.
