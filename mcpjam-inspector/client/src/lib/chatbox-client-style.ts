import type { CSSProperties } from "react";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  getHostStyleOrDefault,
  resolveEffectiveHostStyle,
  type ChatUiOverride,
  type HostStyleFamily,
  type HostStyleId,
  type HostThemeMode,
} from "@/lib/client-styles";

/**
 * Identifier of a chatbox host style. Today the registry contains "claude"
 * and "chatgpt" built-ins; project-defined custom hosts will widen this
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

/**
 * Each wrapper accepts an optional `chatUiOverride` and threads it through
 * {@link resolveEffectiveHostStyle}. When the override is absent, the
 * resolver returns the preset by id unchanged — behavior identical to
 * `getHostStyleOrDefault(hostStyle).chatUi.*`. Callers that don't have an
 * override (e.g. id-only chatbox rows from before BYO host styles landed)
 * keep their current call signature.
 */
export function getChatboxHostLabel(
  hostStyle: ChatboxHostStyle,
  chatUiOverride?: ChatUiOverride,
): string {
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi.label;
}

/** User-facing label for chatbox builder surfaces (host style terminology). */
export function getChatboxHostStyleShortLabel(
  hostStyle: ChatboxHostStyle,
  chatUiOverride?: ChatUiOverride,
): string {
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi
    .shortLabel;
}

export function getChatboxHostLogo(
  hostStyle: ChatboxHostStyle,
  chatUiOverride?: ChatUiOverride,
): string {
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi
    .logoSrc;
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
  return getHostStyleOrDefault(hostStyle).mcp.protocolOverride;
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
  chatUiOverride?: ChatUiOverride,
): HostStyleFamily | null {
  if (!hostStyle) return null;
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi.family;
}

export function getChatboxChatBackground(
  hostStyle: ChatboxHostStyle | null | undefined,
  themeMode: HostThemeMode,
  chatUiOverride?: ChatUiOverride,
): string | undefined {
  if (!hostStyle) return undefined;
  return resolveEffectiveHostStyle({
    hostStyle,
    chatUiOverride,
  }).chatUi.resolveChatBackground(themeMode);
}

export function getChatboxShellStyle(
  hostStyle: ChatboxHostStyle,
  themeMode: HostThemeMode,
  chatUiOverride?: ChatUiOverride,
): CSSProperties {
  const definition = resolveEffectiveHostStyle({ hostStyle, chatUiOverride });
  const styleVariables = definition.mcp.resolveStyleVariables(themeMode);
  const background = definition.chatUi.resolveChatBackground(themeMode);
  const resolvedStyleVariables = styleVariables as Record<
    string,
    string | undefined
  >;
  const getStyleVar = (key: string, fallback: string) =>
    resolvedStyleVariables[key] ?? fallback;

  // shadcn / Tailwind `primary` is not part of the MCP Apps token set. Map it
  // from each host's semantic accents so builder chrome (e.g. `bg-primary`,
  // `color-mix(..., var(--primary), ...)`) follows the emulated vendor instead
  // of leaking the app-wide MCPJam primary.
  const primary =
    definition.chatUi.family === "chatgpt"
      ? getStyleVar("--color-border-info", getStyleVar("--color-text-primary", background))
      : getStyleVar(
          "--color-border-warning",
          getStyleVar("--color-text-primary", background),
        );
  const primaryForeground = getStyleVar(
    "--color-text-inverse",
    getStyleVar("--color-background-primary", background),
  );

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
    "--primary": primary,
    "--primary-foreground": primaryForeground,
    "--border": getStyleVar("--color-border-secondary", background),
    "--input": getStyleVar("--color-border-primary", background),
    "--ring": getStyleVar("--color-ring-primary", background),
    "--font-sans": getStyleVar("--font-sans", "ui-sans-serif, sans-serif"),
    "--shadow-sm":
      resolvedStyleVariables["--shadow-sm"] ??
      "0 1px 2px -1px rgba(0, 0, 0, 0.08)",
    "--shadow":
      resolvedStyleVariables["--shadow"] ??
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

/**
 * Applies only the host's primary pair so tab underlines and primary buttons
 * match the emulated client, without swapping `--background` away from the
 * app shell — keeps Connect headers visually aligned with {@link Header}.
 */
export function getHostChromeAccentVariables(
  hostStyle: ChatboxHostStyle | null | undefined,
  themeMode: HostThemeMode,
  chatUiOverride?: ChatUiOverride,
): ChatboxShellStyle | undefined {
  if (!hostStyle) return undefined;
  const shell = getChatboxShellStyle(
    hostStyle,
    themeMode,
    chatUiOverride,
  ) as ChatboxShellStyle;
  return {
    "--primary": shell["--primary"],
    "--primary-foreground": shell["--primary-foreground"],
  };
}
