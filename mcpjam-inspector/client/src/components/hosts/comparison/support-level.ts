/**
 * caniuse-style support semantics for the host comparison matrix.
 *
 * Single source of truth: chips, the per-row coverage stat, the support
 * filters, and the caveat footnotes ALL derive from these helpers so they can
 * never drift apart. A field is "support-shaped" when its kind is `boolean`,
 * `tri-state`, or `capability`; every other kind is a scalar/data value that
 * renders as plain text (no chip, no coverage).
 */

import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { HostConfigFieldDef } from "@/lib/host-config-field-schema";

/**
 * caniuse-grade support level for one (field, host) pair.
 * - `supported`  — capability advertised / boolean `Yes` / tri-state `On`
 * - `partial`    — tri-state `Auto` (host decides), or advertised-with-caveat
 * - `neutral`    — known-off / not advertised (a fact, not a failure)
 * - `unsupported`— reserved for an explicit "not supported"; no field maps here yet
 */
export type SupportLevel = "supported" | "partial" | "neutral" | "unsupported";

/** Kind-based: support-shaped fields get chips/coverage; everything else stays plain. */
export function isSupportField(field: HostConfigFieldDef): boolean {
  const k = field.kind.kind;
  return k === "boolean" || k === "tri-state" || k === "capability";
}

/**
 * Resolve a field's support level for one host. Returns `null` for
 * non-support-shaped fields (scalars, strings, data objects).
 */
export function getSupportLevel(
  field: HostConfigFieldDef,
  cfg: HostConfigDtoV2,
): SupportLevel | null {
  const value = field.read(cfg);
  switch (field.kind.kind) {
    case "boolean":
      return value === true ? "supported" : "neutral";
    case "tri-state":
      if (value === true) return "supported";
      if (value === false) return "neutral";
      return "partial"; // undefined = Auto / host decides
    case "capability": {
      if (value === undefined || value === null) return "neutral";
      if (typeof value === "object") {
        // Advertised, but list-changed notifications opted out → partial.
        if ((value as Record<string, unknown>).listChanged === false) {
          return "partial";
        }
        return "supported";
      }
      return "neutral";
    }
    default:
      return null;
  }
}

/** Support levels across every host for one row (support-shaped fields only). */
export function rowSupportLevels(
  field: HostConfigFieldDef,
  configs: ReadonlyArray<HostConfigDtoV2>,
): SupportLevel[] {
  return configs
    .map((c) => getSupportLevel(field, c))
    .filter((l): l is SupportLevel => l !== null);
}

/**
 * caniuse "global support" equivalent: how many hosts support this row.
 * `null` for non-support rows or when there are no hosts.
 */
export function rowCoverage(
  field: HostConfigFieldDef,
  configs: ReadonlyArray<HostConfigDtoV2>,
): { supported: number; total: number } | null {
  if (!isSupportField(field)) return null;
  const levels = rowSupportLevels(field, configs);
  if (levels.length === 0) return null;
  return {
    supported: levels.filter((l) => l === "supported").length,
    total: levels.length,
  };
}

export type SupportFilterMode = "all" | "missing" | "partial" | "supported";

/** Whether a row survives the active support filter. Scalar rows fail every non-`all` filter. */
export function rowPassesSupportFilter(
  field: HostConfigFieldDef,
  configs: ReadonlyArray<HostConfigDtoV2>,
  mode: SupportFilterMode,
): boolean {
  if (mode === "all") return true;
  if (!isSupportField(field)) return false;
  const levels = rowSupportLevels(field, configs);
  if (levels.length === 0) return false;
  switch (mode) {
    case "missing":
      return levels.some((l) => l === "neutral" || l === "unsupported");
    case "partial":
      return levels.some((l) => l === "partial");
    case "supported":
      return levels.every((l) => l === "supported");
  }
}

/**
 * Per-cell caveats — the "yes, with caveats" footnotes. Small, extensible
 * rule registry; returns `[]` when the value is clean. Only support-shaped
 * capability values currently carry caveats.
 */
export function getCapabilityCaveats(
  field: HostConfigFieldDef,
  cfg: HostConfigDtoV2,
): string[] {
  const caveats: string[] = [];
  if (field.kind.kind !== "capability") return caveats;
  const value = field.read(cfg);
  if (!value || typeof value !== "object") return caveats;
  const rec = value as Record<string, unknown>;

  if (rec.listChanged === false) {
    caveats.push("Advertised without list-changed notifications.");
  }
  if (field.id === "capabilities.sampling" && "tools" in rec) {
    caveats.push("Supports tool use in sampling (SEP-1577).");
  }
  if (
    field.id === "capabilities.experimental" &&
    Object.keys(rec).length > 0
  ) {
    caveats.push("Vendor / experimental — outside the core capability set.");
  }
  return caveats;
}
