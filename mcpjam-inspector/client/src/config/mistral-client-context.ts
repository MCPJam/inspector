/**
 * Mistral (Le Chat) host context.
 *
 * `getMistralStyleVariables` now lives in the SDK
 * (`@mcpjam/sdk/host-config/templates`) so the mistral host-template seed can
 * run in Node; it is re-exported here for a single source of truth.
 * `MISTRAL_PLATFORM` / `MISTRAL_FONT_CSS` / `MISTRAL_CHAT_BACKGROUND` stay local
 * (chat-shell chrome, not used by host-config seeding).
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getMistralStyleVariables as sdkGetMistralStyleVariables } from "@mcpjam/sdk/host-config/templates";

// Re-assert the `McpUiStyles` return the host-style registry expects (the SDK
// fn types its return as the structurally-identical `Record<string, string>`).
export const getMistralStyleVariables = sdkGetMistralStyleVariables as (
  theme: "light" | "dark",
) => McpUiStyles;

export const MISTRAL_PLATFORM = "web" as const;

export const MISTRAL_CHAT_BACKGROUND = {
  light: "#fff",
  dark: "#111115",
};

export const MISTRAL_FONT_CSS = ``;
