---
"@mcpjam/inspector": patch
---

In Playground Compare, each client column now resolves its saved model through its own harness, so a Codex or ChatGPT column keeps its model when a Claude Code client leads. A Cursor CLI column shows Cursor Auto, and Send waits when a column's model or connection changed after it loaded.
