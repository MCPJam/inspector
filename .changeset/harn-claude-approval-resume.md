---
"@mcpjam/inspector": patch
---

Refresh native forwarding configuration before resuming a paused Claude Code tool approval. Close each native HTTP connection so a resumed process receives the current sandbox credential, and use that credential's run identity for approvals and results. Refuse to restart a lost pending turn or resume with a changed tool policy.
