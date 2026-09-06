import type { CSSProperties } from "react";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  getHostStyleOrDefault,
  listHostStyles,
  resolveEffectiveHostStyle,
  type ChatUiOverride,
  type HostChatUi,
  type HostStyleFamily,
  type HostStyleId,
  type HostThemeMode,
} from "@/lib/client-styles";

/**
 * Identifier of a scenario host style. Today the registry contains "claude"
 * and "chatgpt" built-ins; project-defined custom hosts will widen this
 * at the value level without changing this string-based type.
 */
export type ScenarioHostStyle = HostStyleId;

type ScenarioShellStyle = CSSProperties & Record<`--${string}`, string>;

export function normalizeScenarioHostStyleId(
  hostStyle: unknown
): ScenarioHostStyle | null {
  if (typeof hostStyle !== "string") return null;
  const trimmed = hostStyle.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Each wrapper accepts an optional `chatUiOverride` and threads it through
 * {@link resolveEffectiveHostStyle}. When the override is absent, the
 * resolver returns the preset by id unchanged — behavior identical to
 * `getHostStyleOrDefault(hostStyle).chatUi.*`. Callers that don't have an
 * override (e.g. id-only scenario rows from before BYO host styles landed)
 * keep their current call signature.
 */
export function getScenarioHostLabel(
  hostStyle: ScenarioHostStyle,
  chatUiOverride?: ChatUiOverride
): string {
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi.label;
}

/** User-facing label for scenario builder surfaces (host style terminology). */
export function getScenarioHostStyleShortLabel(
  hostStyle: ScenarioHostStyle,
  chatUiOverride?: ChatUiOverride
): string {
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi
    .shortLabel;
}

export function getScenarioHostLogo(
  hostStyle: ScenarioHostStyle,
  chatUiOverride?: ChatUiOverride,
  themeMode?: HostThemeMode | null
): string {
  return getHostLogoSrc(
    resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi,
    themeMode
  );
}

export function getHostLogoSrc(
  chatUi: Pick<HostChatUi, "logoSrc" | "logoSrcByTheme">,
  themeMode?: HostThemeMode | null
): string {
  return themeMode
    ? chatUi.logoSrcByTheme?.[themeMode] ?? chatUi.logoSrc
    : chatUi.logoSrc;
}

/**
 * Match a saved host's display name to a built-in style ID when config is
 * unavailable.
 *
 * The ID-returning half of {@link resolveHostLogoByDisplayName}, split out so
 * callers that need to KNOW the style — not just draw it — run the same
 * comparison. It places ids the logo hint table never lists (`codex`,
 * `agentcore`, `n8n`), which is exactly the set a hint-table-only resolver
 * silently misses.
 */
export function resolveHostStyleByDisplayName(
  displayName: string
): string | null {
  const needle = displayName.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return null;

  for (const style of listHostStyles()) {
    const id = style.id.toLowerCase();
    const label = style.chatUi.label.toLowerCase().replace(/\s+/g, "");
    const shortLabel = style.chatUi.shortLabel
      .toLowerCase()
      .replace(/\s+/g, "");
    if (needle === id || needle === label || needle === shortLabel) {
      return style.id;
    }
  }
  return null;
}

/** Match a saved host's display name to a built-in style logo when config is unavailable. */
export function resolveHostLogoByDisplayName(
  displayName: string,
  themeMode?: HostThemeMode | null
): string | null {
  const styleId = resolveHostStyleByDisplayName(displayName);
  return styleId ? getScenarioHostLogo(styleId, undefined, themeMode) : null;
}

/**
 * MCP-Apps protocol the host emulates. Falsy input (no scenario context)
 * returns `undefined` so callers can apply their own default; truthy-but-
 * unregistered ids resolve to the default host's protocol via
 * {@link getHostStyleOrDefault}, matching the rest of this file's fallback.
 */
export function getScenarioProtocolOverride(
  hostStyle: ScenarioHostStyle | null | undefined
): UIType | undefined {
  if (!hostStyle) return undefined;
  return getHostStyleOrDefault(hostStyle).mcp.protocolOverride;
}

/**
 * Visual rendering family the host maps onto. Use this — not equality
 * against the host id — when branching on chat-v2 visual variants so that
 * new host styles automatically pick up an existing visual language.
 *
 * Returns `null` only when `hostStyle` is falsy (no scenario context). Any
 * truthy-but-unregistered id is resolved through {@link getHostStyleOrDefault}
 * and therefore reports the default host's family ("claude"); call sites
 * matching `family === "claude"` will also catch unregistered ids.
 */
export function getScenarioHostFamily(
  hostStyle: ScenarioHostStyle | null | undefined,
  chatUiOverride?: ChatUiOverride
): HostStyleFamily | null {
  if (!hostStyle) return null;
  return resolveEffectiveHostStyle({ hostStyle, chatUiOverride }).chatUi.family;
}

export function getScenarioChatBackground(
  hostStyle: ScenarioHostStyle | null | undefined,
  themeMode: HostThemeMode,
  chatUiOverride?: ChatUiOverride
): string | undefined {
  if (!hostStyle) return undefined;
  return resolveEffectiveHostStyle({
    hostStyle,
    chatUiOverride,
  }).chatUi.resolveChatBackground(themeMode);
}

export function getScenarioShellStyle(
  hostStyle: ScenarioHostStyle,
  themeMode: HostThemeMode,
  chatUiOverride?: ChatUiOverride
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

  const shellStyle: ScenarioShellStyle = {
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
