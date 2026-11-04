---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Conformance: check ids from older releases keep working instead of failing as unknown. `modern-log-level-filtering` runs the `readiness-log-level-filtering` advice that replaced it, and `tasks-input-required-update-completes` runs as `tasks-update-ack-shape`. The CLI prints a note naming the replacement.
