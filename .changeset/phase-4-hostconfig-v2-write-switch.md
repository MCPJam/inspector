---
"@mcpjam/inspector": patch
---

Phase 4 HostConfig v2 write switch (inspector): connection settings now route through `hostConfigsV2.patchProjectDefaultConnection` instead of the legacy `projects.updateProjectClientConfig` (mutation completion is the durability signal — no project-doc echo round-trip). Eval suite settings replace "Remove" with "Reset to project default" which copies the current project default into the suite's owned `hostConfigId`. Chatbox builder draft loader migrates older sessionStorage drafts (missing fields filled from the blank starter) so persisted drafts from previous shapes don't crash the builder.
