/**
 * SEP-1865 tool visibility helpers — back-compat re-export shim.
 *
 * The implementations now live in `@mcpjam/sdk/widget-runtime` (Tier B
 * Phase 2). This module re-exports the same named symbols so existing import
 * sites (`@/lib/mcp-ui/tool-visibility`, e.g. `mcp-apps-utils.ts` and the
 * framework-free `host-app-bridge.ts`) keep working unchanged.
 */

export {
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "@mcpjam/sdk/widget-runtime";
