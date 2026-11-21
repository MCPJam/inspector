---
"@mcpjam/cli": patch
---

`mcpjam cloud eval validate --project` now checks the servers a suite file targets, not only its deterministic tool calls. A server the project lacks is a `SERVER_UNRESOLVED` finding and a disabled one is `SERVER_DISABLED`, in `projectValidation.findings`, and either makes the file invalid. Before, a prompt-only suite naming a missing server validated clean, and a tool call on a missing server was reported as "not part of the target". `eval run --file` refuses the same targets before it writes or launches anything. Without `--project`, validation stays offline.
