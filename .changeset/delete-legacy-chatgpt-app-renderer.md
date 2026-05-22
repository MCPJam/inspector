---
"@mcpjam/inspector": minor
---

### `@mcpjam/inspector`
- **Delete the legacy `ChatGPTAppRenderer` + `chatgpt-apps` server router**: ~3,400 lines of OpenAI Apps SDK-shaped code removed now that the MCP Apps renderer is the canonical path for both `mcp-apps` and `openai-apps` view-origin tools. Removed: `chatgpt-app-renderer.tsx` (1794 lines), `chatgpt-widget-loaders.ts`, `chatgpt-sandboxed-iframe.tsx`, the `apps-api.ts` client wrapper, the `server/routes/apps/chatgpt-apps/` router (`index.ts` + `sandbox-proxy.html`), and the associated test fixtures and middleware allowlist entries.
- **Renderer entry point unchanged for callers**: the canonical `McpAppsRenderer` already handled OpenAI-origin tools via the `injectOpenAICompat` shim path (covered by the `window-openai-capability-matrix` series), so removing the legacy renderer does not change the user-visible widget rendering surface. Auth-integration and session-auth tests prune their references to the deleted router; sandbox-proxy bundle fresh-check loses the `chatgpt-apps` variant.
- **HOSTED_DEPLOYMENT.md** updated to drop the legacy router from the deployable surface description.
- **No backwards-compat shim**: per the "no vestigial adapters" rule, the deletion is direct — no delegation wrappers, no dynamic-import workarounds. The MCP Apps renderer is the only renderer.
