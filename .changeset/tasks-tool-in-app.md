---
"@mcpjam/inspector": patch
---

Conformance: Run's check list now asks for the tool that creates a task, with its arguments, under the first Tasks check that calls it, and for optional answers under `tasks-update-ack-shape`, sent when the task asks for input. The Tasks run sends them, so the Tasks checks can run on a server that uses the Tasks extension, and `tasks-update-ack-shape` shows in the app again: without answers it is not applicable.
