---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Shared sign-ins and API-uploaded accounts work in the local app (`npx @mcpjam/inspector` and the desktop app). A shared server connects as the project's account once a project admin turns on **Allow local runs** in the server's sharing settings; sharing a server from the dialog now says that members' local apps receive the accounts' access tokens, and turns local runs on with it. An account uploaded to your own server reaches only your local app. Local connects show the backend's refusal and its next step (for example, ask an admin to allow local runs) instead of retrying a refresh that cannot succeed, and the app no longer offers **Reveal tokens** for shared or uploaded accounts. The CLI and SDK descriptions of `server-accounts` uploads say the same.
