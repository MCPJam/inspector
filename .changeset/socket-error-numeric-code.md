---
"@mcpjam/inspector": patch
---

Self-hosted Inspector no longer crashes when a client connection fails with an error whose code is a number. The failure is now counted as "other" in socket diagnostics.
