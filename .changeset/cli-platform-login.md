---
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Add `mcpjam login` / `logout` / `whoami`: OAuth Authorization Code + PKCE login to the MCPJam platform via new hosted bridge routes (`/api/cli/auth/config|start|callback`) on the Inspector server. The bridge signs the CLI's loopback redirect into a short-lived HMAC state and never sees tokens; the CLI exchanges the code directly with AuthKit and stores the session at an XDG-aware path with 0600 permissions, refreshing access tokens near expiry. Platform credentials resolve as `--api-key` > `MCPJAM_API_KEY` > stored login; explicit legacy `mcpjam_` keys error, ambient ones warn and fall through. The SDK now exports its loopback authorization session and PKCE helpers (`createInteractiveAuthorizationSession`, `openUrlInBrowser`, `generateRandomString`, `generateCodeChallenge`). The bridge requires `CLI_AUTH_STATE_SECRET` and `CLI_AUTH_PUBLIC_ORIGIN`; without them it answers 501.
