---
"@mcpjam/inspector": patch
---

A rubric-check question written in suite settings can no longer use an evaluator library preset's question ID, which would make its score rows read as the preset's. Settings say "This ID belongs to a library preset. Enter a different ID.", and IDs made from a question's label skip those IDs.
