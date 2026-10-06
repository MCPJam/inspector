---
"@mcpjam/inspector": minor
---

Run on any loopback port: each instance keeps its own sign-in and guest cookies (one sign-in per instance after upgrading; guest sessions carry over), guests come from one configured guest authority with no runtime configuration writes, local bash requires a verified signed-in member, and `--port` now also moves the CLI login and Slack/Discord callback origins. Development adds `dev:worktree` profiles (`--env-file`, per-instance worker) and `dev:setup-guest-auth`.
