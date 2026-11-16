---
"@mcpjam/sdk": minor
---

Anonymous SDK telemetry now records how runs end. `EvalTest.run`, `runSuiteFile` and `runServerDoctor` each send one `sdk_run_completed` event when they finish, with which of them ran, the outcome (`passed`, `failed`, `errored` or `aborted`), the duration, the iteration count when there is one, and whether it ran in CI. `runSuiteFile` sends one event per call, not one per case. `runEventsConformance` now sends `conformance_run_triggered` like the other conformance runners, and that event now carries the suite family and whether it was a single test or a suite. All SDK events now include the SDK version. No event carries server URLs, tool names, prompts, results or error messages, and `DO_NOT_TRACK=1` or `MCPJAM_TELEMETRY_DISABLED=1` turns them all off.
