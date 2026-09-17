---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Tell agents and scripts when an included operation's usage limit lifts. The SDK adds `describePlatformRefusal` and `platformRefusalHint`, which read a `RATE_LIMITED` refusal's backend code, limit, retry time and whether credits would help. MCP tool errors, CLI errors and in-app agent tool errors now carry that and say when to retry, without suggesting a top-up. Generation copy now says the quota belongs to the organization, not the project, and description proposals no longer claim a generation quota. The insight getters explain `platform_cap_exceeded` and `platform_unavailable`.
