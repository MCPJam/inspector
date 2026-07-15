/**
 * Iframe sandbox attribute construction (SEP-1865) — back-compat re-export shim.
 *
 * The implementation now lives in `@mcpjam/sdk/widget-runtime` (Tier B
 * Phase 2). This module re-exports the same named symbols so existing import
 * sites (`@/lib/mcp-ui/iframe-sandbox-policy`, e.g. `host-app-bridge.ts`,
 * `@/components/ui/sandboxed-iframe`, and the eval browser harness's
 * `host-page.ts`) keep working unchanged.
 */

export {
  DEFAULT_IFRAME_SANDBOX,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
  resolveIframeSandboxPolicy,
} from "@mcpjam/sdk/widget-runtime";
