---
"@mcpjam/inspector": patch
---

Ask before the local inspector starts a project STDIO server whose command this device has not approved. A project server's command, args and environment are editable by every workspace member, and evals, swarms and the Servers tab started it on your machine showing only the server name. The local server now refuses to spawn until this device has approved the exact command (args, env variable names and values, working directory), asks again when it changes, and the Connect click or an eval Start shows the command for review. Auto-connect never prompts; a server awaiting approval shows the reason on its card.
