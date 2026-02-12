import { useMemo } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  getClaudeDesktopStyleVariables,
  CLAUDE_DESKTOP_FONT_CSS,
  CLAUDE_DESKTOP_PLATFORM,
} from "@/config/claude-desktop-host-context";
import { DEFAULT_INPUT_SCHEMA, type DisplayMode } from "./mcp-apps-types";

interface UseMcpAppsHostContextArgs {
  themeMode: string;
  displayMode: DisplayMode;
  locale: string;
  timeZone: string;
  deviceCapabilities: { hover?: boolean; touch?: boolean };
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
  toolCallId: string;
  toolName: string;
  toolMetadata?: Record<string, unknown>;
}

export function useMcpAppsHostContext({
  themeMode,
  displayMode,
  locale,
  timeZone,
  deviceCapabilities,
  safeAreaInsets,
  toolCallId,
  toolName,
  toolMetadata,
}: UseMcpAppsHostContextArgs): McpUiHostContext {
  const normalizedTheme = themeMode === "dark" ? "dark" : "light";
  const styleVariables = useMemo(
    () => getClaudeDesktopStyleVariables(normalizedTheme),
    [normalizedTheme],
  );

  return useMemo<McpUiHostContext>(
    () => ({
      theme: normalizedTheme,
      displayMode,
      availableDisplayModes: ["inline", "pip", "fullscreen"],
      locale,
      timeZone,
      platform: CLAUDE_DESKTOP_PLATFORM,
      userAgent: navigator.userAgent,
      deviceCapabilities,
      safeAreaInsets,
      styles: {
        variables: styleVariables,
        css: { fonts: CLAUDE_DESKTOP_FONT_CSS },
      },
      toolInfo: {
        id: toolCallId,
        tool: {
          name: toolName,
          inputSchema:
            (toolMetadata?.inputSchema as {
              type: "object";
              properties?: Record<string, object>;
              required?: string[];
            }) ?? DEFAULT_INPUT_SCHEMA,
          description: toolMetadata?.description as string | undefined,
        },
      },
    }),
    [
      deviceCapabilities,
      displayMode,
      locale,
      safeAreaInsets,
      styleVariables,
      normalizedTheme,
      timeZone,
      toolCallId,
      toolMetadata,
      toolName,
    ],
  );
}
