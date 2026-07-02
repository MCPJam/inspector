/**
 * L1 widget scan — re-exported from the shared SDK engine
 * (`@mcpjam/sdk/host-compat`). The verdict logic, including the static widget
 * scan, lives in the SDK so every surface (inspector UI, `mcpjam` CLI, public
 * API, MCP server) shares one implementation. This module stays as a stable
 * import path for the existing client consumers.
 */

export {
  scanWidgetSource,
  scanWidgetMeta,
  type WidgetCapabilityNeed,
  type WidgetUsage,
} from "@mcpjam/sdk/host-compat";
