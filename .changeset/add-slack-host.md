---
"@mcpjam/sdk": minor
---

host-compat: add Slack (Slackbot) to the market-host catalog. New `MCP_APPS_SLACK` capability matrix (probe-captured from Slackbot's `ui/initialize`), a `slack` market host (renders MCP Apps, no OpenAI shim, protocol `2025-06-18`), and its bundled-catalog + OpenAI-compat-preset entries. Kept in lockstep with the backend seed.
