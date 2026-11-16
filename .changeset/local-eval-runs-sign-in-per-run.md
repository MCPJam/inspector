---
"@mcpjam/inspector": patch
---

Local eval runs in `npx @mcpjam/inspector` and the desktop app now sign in to their servers for each run, with the accounts chosen in the suite's settings or else the default account, instead of reusing whatever the app had connected. Two runs on different accounts no longer share a connection, and the run records the accounts it used. A chosen account that was removed, needs reconnecting or is no longer allowed here stops the run before it starts, with the reason and what to do next. Local replays sign in the same way instead of using stored tokens, and stop when a server's address changed since the run. When an uploaded test account's token is rejected and cannot be refreshed, MCPJam checks once for a newer upload and otherwise asks you to upload a fresh token.
