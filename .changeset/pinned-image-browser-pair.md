---
"@mcpjam/inspector": minor
---

Eval suites and swarms can use Browser on a run that pins a computer image, when the control plane supports it. The shell, harness and attached files stay on the pinned computer, Browser runs on its own desktop beside it, and `http://localhost:<port>` opens apps running on the pinned computer. Both computers are released when the iteration or session ends. Single-case runs still refuse Browser.
