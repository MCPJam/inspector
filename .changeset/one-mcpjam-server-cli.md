---
"@mcpjam/cli": minor
---

Every command that can contact MCPJam (it accepts `--api-url`, or it uploads results) now decides its server when it starts, by the same order the SDK uses, and refuses before contacting anything. Behavior changes:

- `MCPJAM_BASE_URL` names the same server as `MCPJAM_API_URL` in the older format. Setting the two to different servers exits `2` (`DEPLOYMENT_CONFLICT`).
- A saved login is only sent to its own server. A command that would send it to another server exits `3` (`LOGIN_DEPLOYMENT_MISMATCH`); pass an `sk_` key for that server or run `mcpjam cloud login` for it. A login saved before logins recorded their server counts as an MCPJam Cloud login.
- `cloud login` without an address signs in to the saved login's server again, sends `--api-header` values to the login settings and `/me` only, never to the sign-in provider, and is never blocked by a saved login for another server.
- MCPJam API requests never follow a redirect: a `3xx` answer exits `2` (`BACKEND_REDIRECT_REFUSED`).
- Conformance uploads go to the server from `MCPJAM_API_URL` or `MCPJAM_BASE_URL` with the headers from `MCPJAM_API_HEADERS`. A refused address stops the command instead of printing a warning.
