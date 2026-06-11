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

/**
 * Built-in tool ids the inspector implements as computer-backed. The catalog's
 * `requiresComputer` flag is authoritative for AVAILABILITY (which tools the
 * deployment exposes), but it can be `undefined` while loading and OMITS
 * disabled rows — and `bash` ships disabled until launch. So the CLEANUP paths
 * (detach, eval-suite sanitize) union this known floor with the catalog, to
 * guarantee a computer-dependent id never survives without its resource even
 * when the catalog can't identify it. Mirrors the server resolver's hardcoded
 * `BASH_TOOL_NAME` (server/utils/built-in-tools/registry.ts). This floor is
 * NOT used to decide whether to offer attaching a computer — see
 * `catalogHasComputerBackedTool`, which stays catalog-only so a disabled tool
 * never resurrects a dead pre-launch toggle.
 */
const KNOWN_COMPUTER_BACKED_TOOL_IDS: readonly string[] = ["bash"];

/**
 * Whether the catalog currently exposes a computer-backed tool. Catalog-only
 * (no floor) — this gates OFFERING a computer attachment, which must follow
 * what the deployment has actually enabled.
 */
export function catalogHasComputerBackedTool(
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): boolean {
  return (catalog ?? []).some((t) => t.requiresComputer);
}

/**
 * The set of computer-backed built-in tool ids for CLEANUP purposes: the
 * catalog's `requiresComputer` ids unioned with the known floor, so detaching
 * a computer always strips e.g. `bash` regardless of catalog load state or a
 * disabled row.
 */
export function computerBackedToolIds(
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): Set<string> {
  const ids = new Set<string>(KNOWN_COMPUTER_BACKED_TOOL_IDS);
  for (const tool of catalog ?? []) {
    if (tool.requiresComputer) ids.add(tool.id);
  }
  return ids;
}

/** Patch that attaches a personal computer (the only MVP resource shape). */
export function attachComputerPatch(): Partial<HostConfigInputV2> {
  return { computer: { kind: "personal" } };
}

/**
 * Whether the editor should render the personal-computer toggle. Shown when
 * the catalog exposes a computer-backed tool (so the `bash` row stays hidden
 * until launch) OR when a computer is already attached — so an existing
 * attachment is always DETACHABLE even if no computer-backed tool is currently
 * in the catalog. Never on surfaces that disallow computers (eval suites).
 */
export function shouldShowComputerToggle(opts: {
  catalogHasComputerBackedTool: boolean;
  computerAttached: boolean;
  disallowed?: boolean;
}): boolean {
  if (opts.disallowed) return false;
  return opts.catalogHasComputerBackedTool || opts.computerAttached;
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

/**
 * Sanitize a host config for an eval suite: clear the `computer` resource and
 * strip computer-backed tool ids. Eval runs are aborted by the backend when
 * the resolved host config carries a computer (a personal computer is mutable
 * per-user state an eval can't reproduce), so the eval-suite editor must never
 * persist one — including via "Reset to project default", which copies a
 * project config that may have a computer attached, and on first load of a
 * pre-existing suite config. Returns the SAME reference when already clean so
 * it never introduces spurious dirty state. The `computer` clear is
 * catalog-independent (the part the backend guard keys on); id-stripping is
 * best-effort with whatever catalog has loaded.
 */
export function sanitizeHostConfigForEvalSuite(
  value: HostConfigInputV2,
  catalog: ReadonlyArray<BuiltInToolCatalogEntry> | undefined
): HostConfigInputV2 {
  const backed = computerBackedToolIds(catalog);
  const cleanedIds = value.builtInToolIds.filter((id) => !backed.has(id));
  const idsChanged = cleanedIds.length !== value.builtInToolIds.length;
  if (value.computer === undefined && !idsChanged) return value;
  return { ...value, computer: undefined, builtInToolIds: cleanedIds };
}
