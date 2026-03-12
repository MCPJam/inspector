import type { CSSProperties } from "react";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  CHATGPT_CHAT_BACKGROUND,
  getChatGPTStyleVariables,
} from "@/config/chatgpt-host-context";
import {
  CLAUDE_DESKTOP_CHAT_BACKGROUND,
  getClaudeDesktopStyleVariables,
} from "@/config/claude-desktop-host-context";

export type SandboxHostStyle = "claude" | "chatgpt";

type ResolvedThemeMode = "light" | "dark";

type SandboxShellStyle = CSSProperties & Record<`--${string}`, string>;

export function getSandboxHostLabel(hostStyle: SandboxHostStyle): string {
  return hostStyle === "chatgpt" ? "ChatGPT" : "Claude";
}

export function getSandboxHostLogo(hostStyle: SandboxHostStyle): string {
  return hostStyle === "chatgpt" ? openaiLogo : claudeLogo;
}

export function getSandboxProtocolOverride(
  hostStyle: SandboxHostStyle | null | undefined,
): UIType | undefined {
  if (!hostStyle) return undefined;
  return hostStyle === "chatgpt" ? UIType.OPENAI_SDK : UIType.MCP_APPS;
}

export function getSandboxShellStyle(
  hostStyle: SandboxHostStyle,
  themeMode: ResolvedThemeMode,
): CSSProperties {
  const styleVariables =
    hostStyle === "chatgpt"
      ? getChatGPTStyleVariables(themeMode)
      : getClaudeDesktopStyleVariables(themeMode);
  const background =
    hostStyle === "chatgpt"
      ? CHATGPT_CHAT_BACKGROUND[themeMode]
      : CLAUDE_DESKTOP_CHAT_BACKGROUND[themeMode];
  const resolvedStyleVariables = styleVariables as Record<
    string,
    string | undefined
  >;
  const getStyleVar = (key: string, fallback: string) =>
    resolvedStyleVariables[key] ?? fallback;

  const shellStyle: SandboxShellStyle = {
    "--background": background,
    "--foreground": getStyleVar("--color-text-primary", background),
    "--card": getStyleVar("--color-background-primary", background),
    "--card-foreground": getStyleVar("--color-text-primary", background),
    "--popover": getStyleVar("--color-background-primary", background),
    "--popover-foreground": getStyleVar("--color-text-primary", background),
    "--secondary": getStyleVar("--color-background-secondary", background),
    "--secondary-foreground": getStyleVar("--color-text-primary", background),
    "--muted": getStyleVar("--color-background-secondary", background),
    "--muted-foreground": getStyleVar("--color-text-secondary", background),
    "--accent": getStyleVar("--color-background-tertiary", background),
    "--accent-foreground": getStyleVar("--color-text-primary", background),
    "--border": getStyleVar("--color-border-secondary", background),
    "--input": getStyleVar("--color-border-primary", background),
    "--ring": getStyleVar("--color-ring-primary", background),
    "--font-sans": getStyleVar("--font-sans", "ui-sans-serif, sans-serif"),
    "--shadow-sm":
      resolvedStyleVariables["--shadow-sm"] ??
      "0 1px 2px -1px rgba(0, 0, 0, 0.08)",
    "--shadow":
      resolvedStyleVariables["--shadow-sm"] ??
      "0 1px 2px -1px rgba(0, 0, 0, 0.08)",
    "--shadow-md":
      resolvedStyleVariables["--shadow-md"] ??
      "0 2px 4px -1px rgba(0, 0, 0, 0.08)",
    "--shadow-lg":
      resolvedStyleVariables["--shadow-lg"] ??
      "0 4px 8px -2px rgba(0, 0, 0, 0.1)",
  };

  return shellStyle;
}
