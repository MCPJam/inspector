---
"@mcpjam/cli": minor
---

`mcpjam readiness reviewer start|status|resume|cancel <submission>` drives a reviewer sign-in for a directory submission. `start` takes `--password-secret <name>` (and `--username-secret <name>` or `--username <text>`, `--login-url`, `--tenant`): secret names only, and no flag takes a credential's value. `status` lists the attempts, or shows one with `--attempt <id>`; `resume` and `cancel` take `--attempt <id>`.
