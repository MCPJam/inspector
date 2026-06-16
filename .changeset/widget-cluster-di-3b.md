---
"@mcpjam/inspector": patch
---

Tier B Phase 3b (in-place DI): invert the last app-state islands in the widget
renderer cluster and extend the Tier-B import guard cluster-wide.

- `widget-replay.tsx` no longer reads `useActiveHostCapsResolver` /
  `hostSupportsWidgetRendering`. The host-support gate is injected as a
  `resolveHostSupportsWidget` prop by PartSwitch (which already computes the
  identical gate), so WidgetReplay keeps its own `serverId` semantics with zero
  `@/contexts` / `@/lib/host-capabilities` coupling.
- `app-tools-registry.ts` no longer imports `@/stores/traffic-log-store`.
  `recordAppToolInvocation` accepts an injected `addTrafficLog` sink that the
  chat (`use-chat-session`) and playground (`useToolExecution`) dispatch hooks
  supply — keeping inspector telemetry out of the soon-to-be-relocated registry
  while preserving the LoggerView mirror. The invocation log still records when
  no sink is injected.
- `useToolInputStreaming.ts` / `widget-replay.tsx` source their type-only
  imports (`ResolvedMcpAppsCapabilities`, `DisplayMode`) from the `WidgetHost`
  contract module instead of `@/lib/client-styles` / `@/stores`.
- The Tier-B guard now covers 7 cluster files (renderer, replay, app-tools
  registry, tool-input streaming, surface store, file messages, mcp-apps utils).

No behavior change.
