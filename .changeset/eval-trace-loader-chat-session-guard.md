---
"@mcpjam/inspector": patch
---

evals: load trace via `chatSessionId` when the legacy `blob` is absent.

After the eval→chatSessions unification dropped the legacy blob writer, new iterations are created with `chatSessionId` set and `blob` unset. `useEvalTraceBlob`'s pre-roundtrip guard still required `iteration.blob`, so the backend action was never called and the trace surface rendered "No trace data is available for this run" while tokens/tool counts populated normally. The hook now gates on either source and re-fires when `chatSessionId` resolves.
