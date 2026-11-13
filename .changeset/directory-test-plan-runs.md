---
"@mcpjam/sdk": minor
---

`dialToolCall` takes the dot paths a test plan captures from a creating call's `structuredContent` and returns only those values, as `captured`; nothing else of a tool's result is kept. `summarizeDirectoryToolTests` blocks a case whose fixture's creating call passed but returned no value for it, and says which value and which case.
