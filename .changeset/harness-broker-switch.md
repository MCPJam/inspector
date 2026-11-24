---
"@mcpjam/inspector": patch
---

Removed the `MCPJAM_HARNESS_BROKER_DELIVERY` operator switch. Harness runs always get their model credentials through the broker, which was already the default and the only credential path.
