---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

`getDirectorySubmissionToolTests` now returns `drafting` when a run drafted arguments: the arguments MCPJam's broker proposed for the plan's cases that had none, the cases it left undrafted and why, how many drafts it dropped, and how many cases it did not send. They are proposals only. The run sent none of them, and they reach the plan only when someone accepts them into a new revision. `PlatformDirectoryTestArgumentDrafting`, `PlatformDirectoryTestArgumentDraft` and `PlatformDirectoryTestArgumentUndecided` describe them.

On the Readiness page, the run button names the saved test plan revision a run starts with, and starting the run authorizes that revision's calls. With no saved plan, a run calls none of the server's tools. A run start that names a revision for a submission with no saved plan now says so, where it answered "Readiness run not found".
