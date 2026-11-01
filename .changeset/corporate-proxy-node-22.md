---
"@mcpjam/cli": minor
"@mcpjam/sdk": patch
---

The CLI now requires Node.js 22 or later (Node.js 20 reached end of life) and works behind a corporate proxy. When `HTTPS_PROXY` or `HTTP_PROXY` is set, every `fetch` request the CLI makes (MCPJam's API, model providers, MCP servers over HTTP) goes through the proxy and honors `NO_PROXY`; `localhost`, `127.0.0.1` and `[::1]` always connect directly, so local MCP servers and the local Inspector keep working. A proxy value without a scheme means `http://`. The relay connection of `mcpjam cloud tunnel` and the `mcpjam oauth` proxy do not use the proxy yet. The update check uses Node.js's own proxy support, and is skipped behind a proxy on Node.js older than 22.21 or 24.5 rather than sent directly. Private CAs keep working through `NODE_EXTRA_CA_CERTS` or `--use-system-ca`.

The connection-timeout diagnosis now suggests `HTTPS_PROXY` and `NO_PROXY` for networks that allow outbound traffic only through a proxy.
