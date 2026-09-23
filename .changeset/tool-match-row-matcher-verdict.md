---
"@mcpjam/inspector": patch
---

The expected-tool-calls score row now records the tool-call matcher's own result. It used to record the whole iteration's verdict, so a failing required assertion or a tool error also failed the tool-call row.
