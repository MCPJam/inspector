---
"@mcpjam/inspector": patch
---

Subscription events now reach only the streams opened under the client manager that produced them, so one manager's notifications and stream changes no longer show up in another manager's subscription stream.
