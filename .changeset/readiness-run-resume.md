---
"@mcpjam/sdk": minor
---

A hosted readiness run whose server-side node stopped can now be resumed by the person who started it. `PlatformApiClient.resumeReadinessRun` and `resumeReadinessRunOperation` (`resume_readiness_run`, in `ALL_OPERATIONS` after `cancel_readiness_run`) run it again with the caller's credentials and return the run's receipt. Run reads carry `resumable: true` while a run waits to be resumed. The operation is available under the `conformance` or `directory-readiness` feature.
