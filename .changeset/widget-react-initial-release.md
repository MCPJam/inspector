---
"@mcpjam/widget-react": minor
---

Initial public release of `@mcpjam/widget-react` — the framework-free interactive MCP-Apps / OpenAI-Apps widget runtime (the renderer that satisfies `@mcpjam/chat-ui`'s `renderWidget` seam). It exposes the `WidgetHost` dependency-inversion contract (`WidgetHostProvider` / `useWidgetHost`), the `MCPAppsRenderer` / `WidgetSurfaceHost` renderer surfaces, the `SandboxedIframe` double-iframe sandbox, and UI-type detection helpers. The published type surface depends only on stable subpaths (`@mcpjam/sdk/browser`, `@mcpjam/sdk/widget-runtime`, `@modelcontextprotocol/*`); no inspector internals leak.
