/**
 * Slack host context.
 *
 * `getSlackStyleVariables` lives in the SDK
 * (`@mcpjam/sdk/host-config/templates`) so the Slack host-template seed can
 * run in Node; it is re-exported here for the browser host-style registry.
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  SLACK_FONT_CSS,
  SLACK_PLATFORM,
  getSlackStyleVariables as sdkGetSlackStyleVariables,
} from "@mcpjam/sdk/host-config/templates";

export const getSlackStyleVariables = sdkGetSlackStyleVariables as (
  theme: "light" | "dark"
) => McpUiStyles;

export { SLACK_FONT_CSS, SLACK_PLATFORM };

export const SLACK_CHAT_BACKGROUND = {
  light: "#fff",
  dark: "#1a1d21",
};
