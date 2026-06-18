---
"@mcpjam/inspector": minor
---

Eval improvements: unify render checks into the prompt-test runner as model-free
per-turn pinned tool calls, add a run timeout, surface clearer errors when eval
`tools/list` or setup fails, and expose full eval suite/case editing through the
public API. Show per-tool quality badges in the Tools tab. Stop persisting OAuth
client secrets in browser storage.
