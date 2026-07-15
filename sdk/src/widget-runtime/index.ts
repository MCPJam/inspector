/**
 * `@mcpjam/sdk/widget-runtime` — framework-free building blocks for the MCP
 * widget/app runtime (SEP-1865). Browser- and Node-safe: no React, no
 * inspector-internal imports.
 *
 * Tier B Phase 2: these modules were relocated here from the MCPJam inspector
 * (tool-visibility, the MCP Apps logging transport, the iframe sandbox policy
 * builders, the host AppBridge surface, and the app-tool invocation lifecycle
 * types), which now re-export from this subpath for back-compat.
 */

export {
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "./tool-visibility.js";

export { LoggingTransport } from "./logging-transport.js";

// Pure JSON helpers shared with the inspector + widget renderer (Phase 3d-ii).
export { extractMethod, stableStringifyJson } from "./json-utils.js";

export {
  DEFAULT_IFRAME_SANDBOX,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
  resolveIframeSandboxPolicy,
} from "./iframe-sandbox-policy.js";
export type { IframeSandboxPermissions } from "./iframe-sandbox-policy.js";

// host-app-bridge: only its UNIQUE members are re-exported here. The bridge
// module also re-exports the tool-visibility + iframe-sandbox-policy helpers
// (the "single framework-free module" convenience harness consumers use), but
// those already flow from the leaf modules above — re-exporting them here too
// would be a duplicate-export conflict.
export {
  createHostAppBridge,
  registerHostBridgeHandlers,
} from "./host-app-bridge.js";
export type {
  WidgetDebugDirection,
  HostBridgeMatrix,
  HostBridgeCallbacks,
  RegisterHostBridgeHandlersOptions,
} from "./host-app-bridge.js";

export type {
  AppToolInvocation,
  AppToolInvocationStatus,
  AppToolInvocationUpdate,
} from "./app-tool-invocations.js";
