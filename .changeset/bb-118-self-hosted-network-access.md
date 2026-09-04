---
"@mcpjam/inspector": patch
---

Self-hosted network access: a real fix for the 403 dead-end, and `MCPJAM_ALLOWED_HOSTS` that works off localhost

Reaching the inspector over the network (a non-localhost host — e.g. a Docker
container at `http://192.168.x.x:6274`) landed on an "Authentication Error"
screen telling the user to "use localhost", which they can't. The screen now
shows the exact host they're on and the one environment variable that unblocks
it, and the expected 403 is no longer reported as an error.

`MCPJAM_ALLOWED_HOSTS` now actually opens that path. It was previously inert
unless hosted mode was on; it is now honored in self-hosted mode too, for both
the session-token gate and the request-origin gate, so one variable makes the
inspector reachable off localhost. Tunnel/relay hosts are still vetoed before
the allowlist in both gates, and wildcard entries are honored for origin
validation only under `MCPJAM_ALLOW_WILDCARD_ORIGINS`.

BEHAVIOR CHANGE ON UPGRADE: if you already set `MCPJAM_ALLOWED_HOSTS` in a
self-hosted deployment (e.g. inherited from a shared `.env`), it was doing
nothing before and now takes effect — those hosts will receive the session
token and be accepted as request Origins. Because an allowlisted host is also
accepted as an Origin, it can reach the local shell and agent-browser tools,
which are on by default in self-hosted mode; set
`MCPJAM_LOCAL_COMPUTER_ENABLED=false` / `MCPJAM_LOCAL_BROWSER_ENABLED=false` to
disable them. Audit any inherited value before upgrading.
