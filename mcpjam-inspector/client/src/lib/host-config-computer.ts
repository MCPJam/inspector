/**
 * Helpers for the host-config personal-computer attachment, shared by every
 * editor surface (ClientConfigEditor, BehaviorTab) so the "computer ↔
 * computer-backed tool" invariant is enforced identically everywhere.
 *
 * The invariant (also enforced backend-side in `ensureHostConfigV2`): a
 * computer-backed built-in tool (catalog `requiresComputer`, e.g. `bash`) is
 * only valid when the host also attaches a `computer` resource.
 */
import type { BuiltInToolCatalogEntry } from "@/hooks/useBuiltInToolCatalog";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";

export function catalogHasComputerBackedTool(
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): boolean {
  return (catalog ?? []).some((t) => t.requiresComputer);
}

export function computerBackedToolIds(
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): Set<string> {
  return new Set(
    (catalog ?? []).filter((t) => t.requiresComputer).map((t) => t.id)
  );
}

/** Patch that attaches a personal computer (the only MVP resource shape). */
export function attachComputerPatch(): Partial<HostConfigInputV2> {
  return { computer: { kind: "personal" } };
}

/**
 * Patch that detaches the computer AND drops any computer-backed tool ids, so
 * the resulting draft can't fail the backend's requiresComputer invariant on
 * save (detaching the resource must take its dependent capabilities with it).
 */
export function detachComputerPatch(
  value: HostConfigInputV2,
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): Partial<HostConfigInputV2> {
  const backed = computerBackedToolIds(catalog);
  return {
    computer: undefined,
    builtInToolIds: value.builtInToolIds.filter((id) => !backed.has(id)),
  };
}
