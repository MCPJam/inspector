---
"@mcpjam/inspector": patch
---

The Playground now shows a question a server asks during a local chat without a project, in the same form dialog the other tabs use, and sends the answer back. Before, the server waited on a dialog that never appeared, because only the Tasks tab listened for these questions and it shows task questions alone.
