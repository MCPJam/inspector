---
"@mcpjam/sdk": minor
---

`update_directory_submission` takes `checkGate` (`{ failOn?, warnOnly? }`, or `null` to restore the directory's blocking checks), saved under the same revision guard as an answer, and a gate on its own is a change worth saving. `get_directory_submission_results` returns `verdict`: the run judged with `directoryVerdict` under the submission's gate on the hosted path, decided from each finding's full details before they are left out of the result. `PlatformDirectorySubmission`, `PlatformDirectorySubmissionResults` and `PlatformDirectorySubmissionUpdateBody` carry `checkGate`, and `updateDirectorySubmission` sends it.
