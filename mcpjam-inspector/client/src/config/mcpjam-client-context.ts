/**
 * MCPJam host context — the inspector's own house chrome.
 *
 * The style-variable maps + `getMcpJamStyleVariables` now live in the SDK
 * (`@mcpjam/sdk/host-config/templates`) so the host-template seeds can run in
 * Node (the server `--template` resolver). They are re-exported here so the
 * client importers (`client-styles/built-ins.ts`) keep one import path and
 * there is a single source of truth. `MCPJAM_CHAT_BACKGROUND` stays local — it
 * is chat-shell chrome, not part of host-config seeding.
 *
 * Values mirror `design-system/src/tokens.css` (the `@mcpjam/design-system`
 * package consumed by `client/src/index.css`).
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getMcpJamStyleVariables as sdkGetMcpJamStyleVariables } from "@mcpjam/sdk/host-config/templates";

export {
  MCPJAM_PLATFORM,
  MCPJAM_FONT_CSS,
} from "@mcpjam/sdk/host-config/templates";

// The SDK fn types its return as `Record<string, string>` (no McpUiStyles dep);
// re-assert the `McpUiStyles` return the inspector's host-style registry
// expects. The two are structurally the same CSS-variable map.
export const getMcpJamStyleVariables = sdkGetMcpJamStyleVariables as (
  theme: "light" | "dark",
) => McpUiStyles;

/**
 * Chat-surface background. Mirrors design-system `--background` exactly
 * — the warm cream `oklch(0.9818 0.0054 95.0986)` in light and the warm
 * deep brown `oklch(0.2679 0.0036 106.6427)` in dark.
 */
export const MCPJAM_CHAT_BACKGROUND = {
  light: "oklch(0.9818 0.0054 95.0986)",
  dark: "oklch(0.2679 0.0036 106.6427)",
};
