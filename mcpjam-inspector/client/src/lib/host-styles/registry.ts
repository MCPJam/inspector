import { BUILT_IN_HOST_STYLES, CLAUDE_HOST_STYLE } from "./built-ins";
import type { HostStyleDefinition, HostStyleId } from "./types";

const registry = new Map<HostStyleId, HostStyleDefinition>();

for (const definition of BUILT_IN_HOST_STYLES) {
  registry.set(definition.id, definition);
}

/** Host returned when an id is unknown or absent. */
export const DEFAULT_HOST_STYLE: HostStyleDefinition = CLAUDE_HOST_STYLE;

/**
 * Register an additional host style at runtime. Intended for workspace-defined
 * custom hosts loaded from server config. Built-ins are registered eagerly.
 */
export function registerHostStyle(definition: HostStyleDefinition): void {
  registry.set(definition.id, definition);
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

export function isKnownHostStyleId(id: unknown): id is HostStyleId {
  return typeof id === "string" && registry.has(id);
}

/** Snapshot of all currently registered host styles, in registration order. */
export function listHostStyles(): readonly HostStyleDefinition[] {
  return Array.from(registry.values());
}
