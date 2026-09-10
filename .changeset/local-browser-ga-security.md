---
"@mcpjam/inspector": patch
---

Harden the local Browser and WebMCP runtimes: local Node and Electron engines
now enforce navigation and DNS-checked egress policy and refuse MCPJam's own
controller listeners; browser operations, viewers, retained CDP handles and
downloads end with the consent that authorized them; WebMCP sessions are bound
to a verified owner and project with single-use frame-stream nonces, and
Electron profiles are isolated per actor and project; Electron downloads
require native approval and are staged privately under bounded resources.
Electron is pinned to 43.6.0.

Local Browser stays behind its rollout flag, and this release does not enable
it.
