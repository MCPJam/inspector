---
"@mcpjam/inspector": patch
---

Ship the local-harness runtime pack digest table at pack version 3.3.6, built
and signed by CI for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and
win32-x64. This is also what re-enables the pack build on the release: it runs
when the committed table names a pack, and until now the table was empty.
