/**
 * Cursor host context — captured from a real Cursor 3.4.17 host probe.
 *
 * Cursor doesn't push a `styles.variables` block in `hostContext`, so the
 * shell tokens reuse ChatGPT's neutral-gray IDE palette as a baseline.
 * Refine if/when Cursor publishes its own SEP-1865 token set, or if the
 * brand chrome diverges enough that the shared palette feels off.
 *
 * Verified facts (from probe):
 *   - hostInfo.name: "Cursor", version: "3.4.17"
 *   - clientInfo.name: "cursor-vscode" (MCP layer; outer ide identity)
 *   - protocolVersion: "2026-01-26"
 *   - platform: "desktop"
 *   - displayMode: "inline" (only)
 *   - styles: not provided
 *   - fontCss: not provided
 *   - hostCapabilities: openLinks, serverTools (listChanged: false),
 *       serverResources (listChanged: false), logging — NO updateModelContext,
 *       NO message
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getChatGPTStyleVariables } from "./chatgpt-client-context";

export const CURSOR_PLATFORM = "desktop" as const;

/**
 * Cursor's chat panel background. Mirrors VS Code / Cursor's standard
 * editor surface (~#1f1f1f dark, white light). Independent from the
 * widget token set above so we can iterate on it in isolation.
 */
export const CURSOR_CHAT_BACKGROUND = {
  light: "rgba(255, 255, 255, 1)",
  dark: "rgba(31, 31, 31, 1)",
};

// Cursor doesn't bundle custom @font-face — it uses system + editor fonts.
// Leaving this empty means the iframe inherits the host's defaults.
export const CURSOR_FONT_CSS = ``;

/**
 * Cursor host style variables. Until Cursor publishes its own token set
 * (or we capture one), reuse ChatGPT's resolved variables — both surfaces
 * lean on neutral grays and a similar dark IDE aesthetic, so the shell
 * tokens map cleanly enough for the picker, builder chrome, and any
 * widget that gates on standard SEP-1865 tokens.
 */
export function getCursorStyleVariables(theme: "light" | "dark"): McpUiStyles {
  return getChatGPTStyleVariables(theme);
}
