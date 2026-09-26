---
"@mcpjam/inspector": patch
---

GitHub PR checks run every environment of a multi-environment suite.

- The check worker reads the run set the backend froze on the check plan and launches one run per environment against the PR's temporary server, each with its backend-authored run key. It binds every run at launch before any executes, and the check passes only when all of them pass.
- A binding that is refused, or a run that fails before its verdict, settles the runs that will not execute, so none is left running. A retried check reuses runs that already finished instead of running them again.
