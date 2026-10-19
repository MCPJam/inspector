---
"@mcpjam/inspector": patch
---

Each plugin onboarding attempt now gets a reference that Logs show when it starts. The server records how far that attempt got: admission, authorization, connection, tools, the model, its first output, and how it ended. When an attempt is still unfinished after a minute, the server records where it stopped, so a later retry that works can't hide it. The record holds only IDs, codes, counts and timings.
