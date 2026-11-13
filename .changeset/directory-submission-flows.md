---
"@mcpjam/sdk": minor
---

Claude's "Submit an MCP connector" form is now available as data: `DIRECTORY_FLOWS`, `getDirectoryFlow` and `CLAUDE_CONNECTOR_FLOW` describe its ten steps with the portal's labels, defaults and error lines, and say where each Claude readiness check belongs. `validateDirectoryAnswers` and `validateDirectoryAnswerInput` check a submission's answers the way the portal does, `withDirectoryFlowDefaults` and `directoryFieldWordingRevision` help store them, and `placeDirectoryResults` puts a run's findings on the portal's steps with an evidence status (established, inconclusive, stale, not tested or blocked). All of these are also exported from `@mcpjam/sdk/browser`.

`gradeClaudeReadiness` accepts `submissionAnswers` and grades the listing, link and acknowledgment checks with the portal's rules; `claudeSubmissionEvidenceFromAnswers` returns what it reads. The screenshot checks report not applicable for a connector submission. `CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength` is 200, as the portal counts it, and a submission profile's tagline may be that long; `taglineMaxLength` now matches it and is deprecated. The submission profile (`submissionProfile`, `parseClaudeSubmissionProfile`, `claudeSubmissionProfileSchema` and their types) keeps working and is deprecated in favor of submission answers.
