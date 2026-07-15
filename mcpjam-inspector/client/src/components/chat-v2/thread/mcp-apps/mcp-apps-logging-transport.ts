/**
 * LoggingTransport — back-compat re-export shim.
 *
 * The implementation now lives in `@mcpjam/sdk/widget-runtime` (Tier B
 * Phase 2). This module re-exports it so existing import sites
 * (`./mcp-apps-logging-transport`, e.g. `mcp-apps-renderer.tsx` and
 * `mcp-apps-modal.tsx`) keep working unchanged.
 */

export { LoggingTransport } from "@mcpjam/sdk/widget-runtime";
