---
"@mcpjam/sdk": minor
---

Five platform operations drive a reviewer sign-in for a directory submission: `createReviewerAttemptOperation`, `listReviewerAttemptsOperation`, `getReviewerAttemptOperation`, `resumeReviewerAttemptOperation` and `cancelReviewerAttemptOperation`, in `ALL_OPERATIONS` after the directory submission operations. Their inputs take project secret names only and refuse any field they do not name. The `directory-readiness` feature gates starting and resuming; reading and cancelling stay open.
