---
"@mcpjam/sdk": minor
---

`PlatformApiClient` reads and writes a directory submission's reviewer sign-in attempts: `createDirectoryReviewerAttempt` (secret names and plain fields only; returns the attempt and the readiness run that signs in), `listDirectoryReviewerAttempts`, `getDirectoryReviewerAttempt`, `resumeDirectoryReviewerAttempt` and `cancelDirectoryReviewerAttempt`, with the `PlatformReviewerAttempt` types. `startDirectorySubmissionRun` takes an optional `reviewerAttemptId` for a run to work on a running attempt.
