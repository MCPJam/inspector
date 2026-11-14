---
"@mcpjam/inspector": patch
---

`PATCH /api/v1/projects/:projectId/directory-submissions/:submissionId` accepts `checkGate` (`{ failOn?, warnOnly? }`, or `null` to clear it) and forwards it to the backend's revision guard, and the submission's results answer with the `checkGate` they are judged under.
