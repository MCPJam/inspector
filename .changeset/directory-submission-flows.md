---
"@mcpjam/sdk": minor
---

Claude's "Submit an MCP connector" form is now available as data: `DIRECTORY_FLOWS`, `getDirectoryFlow` and `CLAUDE_CONNECTOR_FLOW` describe its ten steps with the portal's labels, defaults and error lines, and say where each Claude readiness check belongs. `withDirectoryFlowDefaults` and `directoryFieldWordingRevision` help store a submission's answers. All of these are also exported from `@mcpjam/sdk/browser`.

`CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength` is 200, as the portal counts it, and a submission profile's tagline may be that long; `taglineMaxLength` now matches it and is deprecated.
