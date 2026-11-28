---
"@mcpjam/cli": patch
---

On Windows, `mcpjam events subscribe --secret-file` no longer warns that an existing secret file is readable by other users and tells you to `chmod 600` it. Windows reports mode 666 for every writable file and ignores `chmod`, so the warning fired on every rerun and could not be acted on.
