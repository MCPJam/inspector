---
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
---

Trustworthy eval scores and safer sandboxes.

- Trials that fail on MCPJam's own infrastructure (a model-provider outage or rate limit, a sandbox, a lost worker) are recorded with `infraError`, excluded from every pass rate and verdict, and refunded. Exposed on eval iterations in the API and SDK (`PlatformEvalIteration.infraError`).
- Optional safe in-place retry of infrastructure failures, only with durable proof the attempt dispatched nothing effectful, plus a per-run cap on concurrent cases.
- Rerun only the failed cases of a run, re-grade a run from its stored traces, and pass@k / pass^k with Wilson intervals on run results.
- Case authoring warnings for checks that cannot fail, and an empty run is reported inconclusive instead of passing.
- Eval runs interrupted by a deploy are handed back to the backend instead of timing out whole, and can resume on another worker.
- A pinned, pre-baked hosted harness template, and a Docker sandbox provider used by a new hosted-harness CI job.

Every behavior change is off by default behind its own flag.
