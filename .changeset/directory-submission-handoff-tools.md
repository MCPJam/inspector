---
"@mcpjam/inspector": patch
---

The in-app chat and the agent API can resume a directory submission from its id: they read its handoff summary, findings, one finding's evidence, the export pack and the recorded events, and record a status, a snapshot or what the directory said. In the chat, a record asks first. `POST /api/v1/projects/:projectId/directory-submissions/:submissionId/events` keys a record on the agent's idempotency header, so a retried agent turn returns the event it already recorded instead of recording it twice.
