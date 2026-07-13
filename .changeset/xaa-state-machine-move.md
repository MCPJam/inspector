---
"@mcpjam/sdk": minor
---

Move the XAA (ID-JAG) stepwise state machine into the SDK (`xaa/state-machines/state-machine.ts`, exported from `@mcpjam/sdk/browser` as `createXAAStateMachine`), so the inspector and (eventually) the CLI share one engine. Adds `runXaaStateMachine`, a runner that drives the machine to completion or an explicit stop step/predicate. The engine's human-facing `NEGATIVE_TEST_MODE_DETAILS` table moves to the SDK too (single source of truth). The inspector's client state machine becomes a thin re-export shim; all DCR/CIMD/pre-registered/stored-registration flows, manual stepping, history, logs, retry/reset, negative-mode behavior, and hosted issuer modes are preserved (the moved 46-test suite is the golden verification). The browser-purity guard confirms the engine pulls no Node builtin.
