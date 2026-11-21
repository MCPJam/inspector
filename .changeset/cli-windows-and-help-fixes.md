---
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

`mcpjam inspector start` works on Windows again when the Inspector is not installed next to the CLI. It spawned `npx.cmd` without a shell, which Node refuses with `spawn EINVAL` since its CVE-2024-27980 fix. It now runs npx through cmd.exe with each argument quoted, in a hidden window.

JSON flags that read `@file` or `-` (stdin) now accept input saved with a UTF-8 byte-order mark, which Notepad and PowerShell's `Out-File -Encoding utf8` write. Such files used to fail with "must be valid JSON".

The `mcpjam cloud sessions browser` subcommands now have help text.
