/**
 * Visual Studio Code 1.130.0 host context.
 *
 * The resolved light/dark MCP Apps variables live in the SDK so the client
 * shell and Node-safe host-template seed share the live probe captures.
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getVscodeStyleVariables as sdkGetVscodeStyleVariables } from "@mcpjam/sdk/host-config/templates";

export const getVscodeStyleVariables = sdkGetVscodeStyleVariables as (
  theme: "light" | "dark"
) => McpUiStyles;

export const VSCODE_PLATFORM = "desktop" as const;
export const VSCODE_FONT_CSS = ``;
export const VSCODE_CHAT_BACKGROUND = {
  light: "#ffffff",
  dark: "#1e1e1e",
};
