---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add MCPJam tunnels to the platform surface and CLI. The SDK gains `createTunnel`/`closeTunnel` on `PlatformApiClient` plus the `create_tunnel`/`close_tunnel` operations (`@mcpjam/sdk/platform`); the CLI gains `mcpjam tunnel`, which exposes a local MCP server (HTTP URL or stdio command) through a public MCPJam tunnel URL and registers it as a server in your hosted project. The CLI's tunnel command requires this SDK version's platform exports, so the two release together.
