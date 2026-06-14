---
"@mcpjam/chat-ui": minor
---

Add a `@mcpjam/chat-ui/trace` subpath export: Tier-A-compatible trace/replay
adaptation logic (`adaptTraceToUiMessages`, `snapshotsToTraceWidgetSnapshots`,
`buildToolRenderOverridesFromSnapshots`, `buildPersistedExecutionReplay`, and
the `TraceInput` / `TraceContentPart` / `TraceMessage` / `TraceWidgetSnapshot` /
`AdaptedTraceResult` types). Provider-free and free of the React
renderer/markdown graph; widget/CSP types are structural placeholders, so it
carries no eval-domain or MCP-Apps SDK type dependencies.
