import type { CSSProperties } from "react";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  getHostStyleOrDefault,
  type HostStyleFamily,
  type HostStyleId,
  type HostThemeMode,
} from "@/lib/host-styles";

/**
 * Identifier of a chatbox host style. Today the registry contains "claude"
 * and "chatgpt" built-ins; workspace-defined custom hosts will widen this
 * at the value level without changing this string-based type.
 */
export type ChatboxHostStyle = HostStyleId;

type ChatboxShellStyle = CSSProperties & Record<`--${string}`, string>;

export function normalizeChatboxHostStyleId(
  hostStyle: unknown,
): ChatboxHostStyle | null {
  if (typeof hostStyle !== "string") return null;
  const trimmed = hostStyle.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getChatboxHostLabel(hostStyle: ChatboxHostStyle): string {
  return getHostStyleOrDefault(hostStyle).label;
}

/** User-facing label for chatbox builder surfaces (host style terminology). */
export function getChatboxHostStyleShortLabel(
  hostStyle: ChatboxHostStyle,
): string {
  return getHostStyleOrDefault(hostStyle).shortLabel;
}

export function getChatboxHostLogo(hostStyle: ChatboxHostStyle): string {
  return getHostStyleOrDefault(hostStyle).logoSrc;
}

/**
 * MCP-Apps protocol the host emulates. Falsy input (no chatbox context)
 * returns `undefined` so callers can apply their own default; truthy-but-
 * unregistered ids resolve to the default host's protocol via
 * {@link getHostStyleOrDefault}, matching the rest of this file's fallback.
 */
export function getChatboxProtocolOverride(
  hostStyle: ChatboxHostStyle | null | undefined,
): UIType | undefined {
  if (!hostStyle) return undefined;
  return getHostStyleOrDefault(hostStyle).protocolOverride;
}

/**
 * Visual rendering family the host maps onto. Use this — not equality
 * against the host id — when branching on chat-v2 visual variants so that
 * new host styles automatically pick up an existing visual language.
 *
 * Returns `null` only when `hostStyle` is falsy (no chatbox context). Any
 * truthy-but-unregistered id is resolved through {@link getHostStyleOrDefault}
 * and therefore reports the default host's family ("claude"); call sites
 * matching `family === "claude"` will also catch unregistered ids.
 */
export function getChatboxHostFamily(
  hostStyle: ChatboxHostStyle | null | undefined,
): HostStyleFamily | null {
  if (!hostStyle) return null;
  return getHostStyleOrDefault(hostStyle).family;
}

export function getChatboxChatBackground(
  hostStyle: ChatboxHostStyle | null | undefined,
  themeMode: HostThemeMode,
): string | undefined {
  if (!hostStyle) return undefined;
  return getHostStyleOrDefault(hostStyle).resolveChatBackground(themeMode);
}

export function getChatboxShellStyle(
  hostStyle: ChatboxHostStyle,
  themeMode: HostThemeMode,
): CSSProperties {
  const definition = getHostStyleOrDefault(hostStyle);
  const styleVariables = definition.resolveStyleVariables(themeMode);
  const background = definition.resolveChatBackground(themeMode);
  const resolvedStyleVariables = styleVariables as Record<
    string,
    string | undefined
  >;
  const getStyleVar = (key: string, fallback: string) =>
    resolvedStyleVariables[key] ?? fallback;

  const shellStyle: ChatboxShellStyle = {
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
