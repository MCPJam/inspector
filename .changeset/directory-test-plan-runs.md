---
"@mcpjam/sdk": minor
---

A readiness run can now execute a directory submission's saved test plan. `startDirectorySubmissionRun` takes `testPlanRevision`, the saved plan revision the run executes; naming it authorizes the plan's calls, and a revision that is no longer current is refused with the current one. `dialToolCall` takes the dot paths a test plan captures from a creating call's `structuredContent` and returns only those values, as `captured`; nothing else of a tool's result is kept. `summarizeDirectoryToolTests` blocks a case whose fixture's creating call passed but returned no value for it, and says which value and which case.
