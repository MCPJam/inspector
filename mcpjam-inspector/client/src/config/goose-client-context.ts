/**
 * Goose Desktop host context.
 *
 * `getGooseStyleVariables` + `GOOSE_FONT_CSS` live in the SDK so the Goose
 * host-template seed can run in Node. This client module re-exports them with
 * the app-bridge style type and keeps chat-shell-only background colors local.
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getGooseStyleVariables as sdkGetGooseStyleVariables } from "@mcpjam/sdk/host-config/templates";

export {
  GOOSE_FONT_CSS,
  GOOSE_PLATFORM,
} from "@mcpjam/sdk/host-config/templates";

export const getGooseStyleVariables = sdkGetGooseStyleVariables as (
  theme: "light" | "dark",
) => McpUiStyles;

export const GOOSE_CHAT_BACKGROUND = {
  light: "#ffffff",
  dark: "#22252a",
};
