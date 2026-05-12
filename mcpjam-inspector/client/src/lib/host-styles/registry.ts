import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import { BUILT_IN_HOST_STYLES, CLAUDE_HOST_STYLE } from "./built-ins";
import type { HostStyleDefinition, HostStyleId } from "./types";

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

/** Host returned when an id is unknown or absent. */
export const DEFAULT_HOST_STYLE: HostStyleDefinition = CLAUDE_HOST_STYLE;

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
  return findHostStyle(id)?.hostCapabilities ?? SPEC_DEFAULT_HOST_CAPABILITIES;
}

export function isKnownHostStyleId(id: unknown): id is HostStyleId {
  return typeof id === "string" && registry.has(id);
}

/** Snapshot of all currently registered host styles, in registration order. */
export function listHostStyles(): readonly HostStyleDefinition[] {
  return Array.from(registry.values());
}
