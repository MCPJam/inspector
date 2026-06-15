/**
 * `@mcpjam/sdk/widget-runtime` — framework-free building blocks for the MCP
 * widget/app runtime (SEP-1865). Browser- and Node-safe: no React, no
 * inspector-internal imports.
 *
 * Tier B Phase 2: these modules were relocated here from the MCPJam inspector
 * (`client/src/lib/mcp-ui/tool-visibility.ts` and
 * `client/src/components/chat-v2/thread/mcp-apps/mcp-apps-logging-transport.ts`),
 * which now re-export from this subpath for back-compat.
 */

export {
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "./tool-visibility.js";

export { LoggingTransport } from "./logging-transport.js";

export {
  DEFAULT_IFRAME_SANDBOX,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
  resolveIframeSandboxPolicy,
} from "./iframe-sandbox-policy.js";
