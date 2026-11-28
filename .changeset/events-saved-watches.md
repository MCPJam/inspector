---
"@mcpjam/inspector": patch
---

Playground event connections no longer skip events. An event that arrives while the agent is busy, or while its server reconnects, waits and runs in order once the agent is free. When you're signed in, a connection is saved with its conversation and client: it comes back after a reload, after leaving the Playground or after switching models, its server reconnects without a sign-in popup in hosted mode, and the events that arrived while the conversation was closed run when you open it (more than three wait for you to run them). Each event runs once even with the conversation open in two tabs, and a connection runs at most 30 events an hour.
