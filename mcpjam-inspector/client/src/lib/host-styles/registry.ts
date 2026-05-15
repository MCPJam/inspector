import { createElement, type ComponentType } from "react";
import type {
  McpUiHostCapabilities,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { BUILT_IN_HOST_STYLES, MCPJAM_HOST_STYLE } from "./built-ins";
import { HostIndicatorDispatch } from "./indicators/host-indicator-dispatch";
import type {
  ChatUiOverride,
  HostChatUi,
  HostMcpProfile,
  HostStyleDefinition,
  HostStyleId,
  HostThemeMode,
  IndicatorDef,
} from "./types";

/**
 * Last-resort fallback used when no host style resolves (e.g., the caller
 * passed an unknown id and we don't want to silently inherit Claude's
 * capability blob). Mirrors the "advertise nothing" position from the SEP —
 * widgets that gate on optional fields will treat them as unsupported.
 *
 * `sandbox` is intentionally omitted; it's per-resource runtime data.
 */
export const SPEC_DEFAULT_HOST_CAPABILITIES: Omit<
  McpUiHostCapabilities,
  "sandbox"
> = {};

const registry = new Map<HostStyleId, HostStyleDefinition>();

for (const definition of BUILT_IN_HOST_STYLES) {
  registry.set(definition.id, definition);
}

/** Host returned when an id is unknown or absent. The inspector's own
 * chrome — keeps "no host selected" surfaces from silently impersonating
 * Claude. */
export const DEFAULT_HOST_STYLE: HostStyleDefinition = MCPJAM_HOST_STYLE;

/**
 * Register an additional app-provided host style. Built-ins are registered
 * eagerly; project-scoped custom hosts will need a scoped layer instead of
 * mutating this process-wide registry.
 */
export function registerHostStyle(definition: HostStyleDefinition): void {
  const id = definition.id.trim();
  if (!id) {
    throw new Error("[host-styles] Host style id is required.");
  }
  if (id !== definition.id) {
    throw new Error(
      `[host-styles] Host style id "${definition.id}" must not contain leading or trailing whitespace.`,
    );
  }
  if (registry.has(id)) {
    throw new Error(`[host-styles] Host style "${id}" is already registered.`);
  }
  registry.set(id, definition);
}

/** Strict lookup. Returns `undefined` when the id is unknown. */
export function findHostStyle(
  id: HostStyleId | null | undefined,
): HostStyleDefinition | undefined {
  if (!id) return undefined;
  return registry.get(id);
}

/** Lookup with claude fallback. Use at boundaries where missing data is normal. */
export function getHostStyleOrDefault(
  id: HostStyleId | null | undefined,
): HostStyleDefinition {
  return findHostStyle(id) ?? DEFAULT_HOST_STYLE;
}

/**
 * Resolve the `hostCapabilities` blob this host style advertises.
 *
 * Unlike {@link getHostStyleOrDefault} this does NOT silently fall back to
 * Claude's preset — an unknown/absent id returns
 * {@link SPEC_DEFAULT_HOST_CAPABILITIES} so the resolved blob reflects an
 * honest "no claims" baseline rather than impersonating Claude.
 */
export function getHostCapabilitiesForStyle(
  id: HostStyleId | null | undefined,
): Omit<McpUiHostCapabilities, "sandbox"> {
  return findHostStyle(id)?.mcp.hostCapabilities ?? SPEC_DEFAULT_HOST_CAPABILITIES;
}

/**
 * Resolve the brand loading indicator component for a host style. Falls
 * back to the default host's indicator (MCPJam) when the id is unknown
 * or absent — matches the rest of the chrome-resolution surface.
 *
 * When `chatUiOverride.indicator` is provided, the returned component is
 * a synthesized `<HostIndicatorDispatch>` wrapper rather than the
 * preset's bespoke component. Override absent or `indicator` field
 * unset → preset behavior unchanged.
 */
export function getLoadingIndicatorForStyle(
  id: HostStyleId | null | undefined,
  chatUiOverride?: ChatUiOverride,
): ComponentType<{ className?: string }> {
  return resolveEffectiveHostStyle({
    hostStyle: id,
    chatUiOverride,
  }).chatUi.loadingIndicator;
}

export function isKnownHostStyleId(id: unknown): id is HostStyleId {
  return typeof id === "string" && registry.has(id);
}

/** Snapshot of all currently registered host styles, in registration order. */
export function listHostStyles(): readonly HostStyleDefinition[] {
  return Array.from(registry.values());
}

/**
 * Resolve the effective `HostStyleDefinition` for a host config row.
 * Precedence:
 *   1. Fields set on `chatUiOverride` (verbatim, override → preset)
 *   2. Fields not set on the override → preset resolved by `hostStyle` id
 *   3. Unknown/absent id → {@link DEFAULT_HOST_STYLE} (MCPJam)
 *
 * The returned definition is a *new* object — built-in definitions are
 * never mutated. `chatUi.loadingIndicator` is a component reference: when
 * `chatUiOverride.indicator` is set, we wrap `<HostIndicatorDispatch>` so
 * the `ComponentType<{ className?: string }>` contract still holds at
 * render boundaries.
 *
 * Style variables: when `chatUiOverride.styleVariables` is set, the
 * override replaces the preset's full per-theme variable map. Partial
 * variable maps are NOT shallow-merged with the preset — half-overrides
 * tend to render as broken palettes (some keys vendor-themed, some not).
 * Callers should pass complete maps or leave the field unset.
 *
 * MCP capabilities and other `HostMcpProfile` fields are NOT touched here;
 * those continue to flow through `resolveEffectiveHostCapabilities` in
 * `lib/host-config-v2.ts`. This resolver is chat-UI-only.
 */
export function resolveEffectiveHostStyle(args: {
  hostStyle: HostStyleId | null | undefined;
  chatUiOverride?: ChatUiOverride;
}): HostStyleDefinition {
  const preset = getHostStyleOrDefault(args.hostStyle);
  const override = args.chatUiOverride;
  if (!override) return preset;

  const family = override.family ?? preset.chatUi.family;
  const chatBackground = override.chatBackground;
  const resolveChatBackground = chatBackground
    ? (theme: HostThemeMode) => chatBackground[theme]
    : preset.chatUi.resolveChatBackground;

  const loadingIndicator: ComponentType<{ className?: string }> =
    override.indicator !== undefined
      ? makeIndicatorComponent(override.indicator)
      : preset.chatUi.loadingIndicator;

  const chatUi: HostChatUi = {
    label: override.label ?? preset.chatUi.label,
    shortLabel: override.shortLabel ?? preset.chatUi.shortLabel,
    pickerDescription:
      override.pickerDescription ?? preset.chatUi.pickerDescription,
    logoSrc: override.logoSrc ?? preset.chatUi.logoSrc,
    family,
    resolveChatBackground,
    loadingIndicator,
  };

  const styleVariables = override.styleVariables;
  const resolveStyleVariables = styleVariables
    ? (theme: HostThemeMode): McpUiStyles => styleVariables[theme]
    : preset.mcp.resolveStyleVariables;

  const mcp: HostMcpProfile = {
    ...preset.mcp,
    fontCss: override.fontCss ?? preset.mcp.fontCss,
    resolveStyleVariables,
  };

  return {
    id: preset.id,
    chatUi,
    mcp,
  };
}

/**
 * Adapt an `IndicatorDef` (data) to the `ComponentType<{ className }>`
 * contract that `HostChatUi.loadingIndicator` requires. The returned
 * component closes over `def` so the resolver can drop it straight into a
 * resolved `HostStyleDefinition` without callers caring whether the
 * underlying source was a built-in component or a data-shaped override.
 */
function makeIndicatorComponent(
  def: IndicatorDef,
): ComponentType<{ className?: string }> {
  function CustomHostIndicator({ className }: { className?: string }) {
    return createElement(HostIndicatorDispatch, { def, className });
  }
  CustomHostIndicator.displayName = `CustomHostIndicator(${def.kind})`;
  return CustomHostIndicator;
}
