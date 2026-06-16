/**
 * host-app-bridge.ts — back-compat re-export shim.
 *
 * The framework-free MCP Apps host bridge surface (SEP-1865) now lives in
 * `@mcpjam/sdk/widget-runtime` (Tier B Phase 2) so the production renderer and
 * the eval browser harness share one source of truth. This file preserves the
 * existing `@/components/chat-v2/thread/mcp-apps/host-app-bridge` import path —
 * including the convenience re-exports of the tool-visibility + iframe sandbox
 * helpers ("the full host surface from a single module") — for the renderer,
 * the harness, and existing tests.
 */

export {
  createHostAppBridge,
  registerHostBridgeHandlers,
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
  DEFAULT_IFRAME_SANDBOX,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
  resolveIframeSandboxPolicy,
} from "@mcpjam/sdk/widget-runtime";
export type {
  WidgetDebugDirection,
  HostBridgeMatrix,
  HostBridgeCallbacks,
  RegisterHostBridgeHandlersOptions,
} from "@mcpjam/sdk/widget-runtime";
