// Relocated to @mcpjam/widget-react (Phase 3d-ii-b). This shim preserves the
// existing import sites — `./app-tools-registry` (modal/renderer/tests) and
// `@/components/chat-v2/thread/mcp-apps/app-tools-registry` (use-chat-session,
// useToolExecution). The store singleton lives in the package and is shared via
// this re-export.
export type {
  AddTrafficLog,
  BridgeId,
  AppToolDescriptor,
  AppInstance,
  AppToolAlias,
  AppToolSnapshotEntry,
  AppToolAttribution,
  AppToolInvocationRecord,
} from "@mcpjam/widget-react";
export {
  useAppToolsRegistry,
  useAppToolInvocationLog,
  recordAppToolInvocation,
  useAppToolAttributionResolver,
  useAppToolAttribution,
  __internal,
} from "@mcpjam/widget-react";
