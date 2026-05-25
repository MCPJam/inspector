---
"@mcpjam/inspector": minor
---

### `@mcpjam/inspector`
- **Persist MCP App surfaces across tool calls and into fullscreen chat** (#2274): MCP App iframes now survive re-renders, message replays, and the inline ↔ fullscreen transition. A new `widget-surface-store` + `widget-surface-host` pair hoists the iframe lifecycle (bridge, registry, teardown, streaming) above the thread so each surface keeps a stable identity tied to its tool call instead of remounting whenever the parent component changes. One surface is rendered per tool call, scoped by resource URI so distinct resources don't share an iframe.
- **App-provided tools registry**: `app-tools-registry.ts` tracks tools advertised by an MCP App's widget so they remain dispatchable for the lifetime of the surface, not just while the originating tool call is the active part. Carries through inline thread, fullscreen overlay, and transcript replay.
- **Fullscreen-chat parity**: `fullscreen-chat-overlay.tsx` adopts the hoisted surface host so opening/closing fullscreen keeps the same iframe instance — no more re-init, no more lost widget state. Forwards the display/own widget id on teardown and on exit-fullscreen, and stamps the current tool id on cached HTML so registrations stay stable.
- **Sandbox/CSP hardening carried over**: `sandboxed-iframe.tsx` updates included for the persistent-surface lifecycle.
- Test coverage: new `widget-surface-*` suites plus extended `FullscreenChatOverlay`, `Thread`, `mcp-apps-renderer`, `useToolInputStreaming`, and `sandboxed-iframe` tests.
