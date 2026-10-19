---
"@mcpjam/inspector": patch
---

The desktop app no longer crashes when another app takes its port while it starts. It now restarts itself once and picks a free port, including when reopening from the macOS dock. If that restart fails too, it explains which port is taken and how to fix it.
