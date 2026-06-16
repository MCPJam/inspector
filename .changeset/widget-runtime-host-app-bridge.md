---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Move the framework-free MCP Apps host bridge surface into the
`@mcpjam/sdk/widget-runtime` subpath (Tier B Phase 2). `createHostAppBridge`,
`registerHostBridgeHandlers` (the SEP-1865 correctness surface — capability
gating, model-only visibility, matrix-gated `sendToolCancelled`, and the
app-tool invocation lifecycle), and the app-tool invocation lifecycle types
(`AppToolInvocation`, `AppToolInvocationStatus`, `AppToolInvocationUpdate`) now
live in the SDK so the production renderer and the eval browser harness share
one source of truth.

This slice introduces a real `@modelcontextprotocol/ext-apps` dependency because
the host bridge needs `AppBridge` as a runtime value. To keep the SDK on
NodeNext and the published `.d.ts` clean for external NodeNext consumers, the
module imports only the `AppBridge` value and derives the ext-apps host types
(`McpUiHostCapabilities`, `McpUiResourceCsp`, `McpUiResourcePermissions`,
`McpUiHostContext`) from the `AppBridge` constructor signature — importing those
types by name is impossible under NodeNext because
`@modelcontextprotocol/ext-apps/app-bridge` re-exports them through an
extensionless `export * from "./types"` the resolver cannot follow. This mirrors
the existing derivation of the bridge-handler param/result types.

The inspector's `host-app-bridge.ts` and `app-tool-invocations.ts` are now thin
back-compat re-export shims, so existing import paths (and the convenience
re-exports of the tool-visibility + iframe-sandbox helpers) are unchanged. No
behavior change.
