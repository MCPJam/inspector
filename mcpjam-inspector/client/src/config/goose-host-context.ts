/**
 * Goose host context
 *
 * Reuses Claude Desktop's 76 MCP Apps spec design tokens for now.
 * Only the chat area background is Goose-specific.
 */

import { getClaudeDesktopStyleVariables } from "./claude-desktop-host-context";

export const getGooseStyleVariables = getClaudeDesktopStyleVariables;

/** Actual Goose chat area background (not a widget design token) */
export const GOOSE_CHAT_BACKGROUND = {
  light: "rgba(255, 255, 255, 1)",
  dark: "rgba(34, 37, 42, 1)",
};
