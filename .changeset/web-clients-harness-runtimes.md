---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Add Claude web and ChatGPT web as harness runtimes behind the `web-clients-enabled` flag. `HARNESS_IDS` accepts `claude-web` and `chatgpt-web`, the platform features add `web-clients`, and the inspector registers both runtimes, whose MCP calls reach a project's servers through the forwarding endpoint.
