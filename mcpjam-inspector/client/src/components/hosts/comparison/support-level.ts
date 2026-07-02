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
import {
  fieldDiverges,
  HOST_CONFIG_FIELDS,
  type HostConfigFieldDef,
  type SupportLevel,
} from "@/lib/host-config-field-schema";

/**
 * caniuse-grade support level for one (field, host) pair. The type lives in the
 * field schema (so it can declare enum→level maps); re-exported here for the
 * comparison components that have always imported it from this module.
 * - `supported`  — capability advertised / boolean `Yes` / tri-state `On`
 * - `partial`    — tri-state `Auto` (host decides), or advertised-with-caveat
 * - `neutral`    — known-off / not advertised (a fact, not a failure)
 * - `unsupported`— reserved for an explicit "not supported"; no field maps here yet
 */
export type { SupportLevel } from "@/lib/host-config-field-schema";

/** Kind-based: support-shaped fields get chips/coverage; everything else stays plain. */
export function isSupportField(field: HostConfigFieldDef): boolean {
  const k = field.kind;
  return (
    k.kind === "boolean" ||
    k.kind === "tri-state" ||
    k.kind === "capability" ||
    k.kind === "mode-set" ||
    (k.kind === "enum" && !!k.support)
  );
}

/**
 * Resolve a field's support level for one host. Returns `null` for
 * non-support-shaped fields (scalars, strings, data objects).
 */
export function getSupportLevel(
  field: HostConfigFieldDef,
  cfg: HostConfigDtoV2
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
        // Only genuine downgrades drop the level. `listChanged: false` is a
        // downgrade (→ partial); the other caveats from `getCapabilityCaveats`
        // (sampling-with-tools, non-empty experimental) are "yes, and" info
        // notes on a fully-advertised capability, so they stay `supported` —
        // the footnote and the level are intentionally independent.
        if ((value as Record<string, unknown>).listChanged === false) {
          return "partial";
        }
        return "supported";
      }
      return "neutral";
    }
    case "enum": {
      // Only enums that declare a support map are support-shaped; the rest
      // (protocol version, CSP mode, …) render as plain text.
      const map = field.kind.support;
      if (!map) return null;
      if (typeof value !== "string") return "neutral";
      return map[value] ?? "neutral";
    }
    case "mode-set": {
      // Aggregate a set of modes into one level: all candidates present →
      // supported, only the minimum (≤1) → neutral, some-but-not-all →
      // partial. The matrix cell still renders the per-mode chips; this is the
      // single-level summary used by coverage / filters / the list view.
      //
      // Count membership of the declared candidates (matching the cell's
      // `Set` check) rather than `value.length`, so duplicate or unknown
      // entries can't disagree with what the grid shows.
      const modes = field.kind.modes;
      const set = new Set(Array.isArray(value) ? (value as string[]) : []);
      const present = modes.filter((m) => set.has(m)).length;
      if (present >= modes.length) return "supported";
      if (present <= 1) return "neutral";
      return "partial";
    }
    default:
      return null;
  }
}

/** Support levels across every host for one row (support-shaped fields only). */
export function rowSupportLevels(
  field: HostConfigFieldDef,
  configs: ReadonlyArray<HostConfigDtoV2>
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
  configs: ReadonlyArray<HostConfigDtoV2>
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
  mode: SupportFilterMode
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

function normalizeFieldSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Free-text match against a field's label / description / id / path. */
export function fieldMatchesQuery(
  field: HostConfigFieldDef,
  loweredQuery: string
): boolean {
  const queryTokens = normalizeFieldSearchText(loweredQuery)
    .split(/\s+/)
    .filter(Boolean);
  if (queryTokens.length === 0) return true;

  const haystackTokens = normalizeFieldSearchText(
    [field.id, field.label, field.path, field.description ?? ""].join(" ")
  )
    .split(/\s+/)
    .filter(Boolean);
  return queryTokens.every((part) =>
    haystackTokens.some((token) => token.startsWith(part))
  );
}

/**
 * The set of field ids visible after applying the diverging toggle, the support
 * filter, and the search query. Shared by the matrix (which rows to render) and
 * the container (the "N / M fields" count) so they never disagree.
 */
export function computeVisibleFieldIds(args: {
  configs: ReadonlyArray<HostConfigDtoV2>;
  divergingOnly: boolean;
  supportFilter: SupportFilterMode;
  searchQuery: string;
}): Set<string> {
  const q = args.searchQuery.trim().toLowerCase();
  const set = new Set<string>();
  for (const field of HOST_CONFIG_FIELDS) {
    if (args.divergingOnly && !fieldDiverges(field, args.configs)) continue;
    if (!rowPassesSupportFilter(field, args.configs, args.supportFilter))
      continue;
    if (!fieldMatchesQuery(field, q)) continue;
    set.add(field.id);
  }
  return set;
}

/**
 * Per-cell caveats — the "yes, with caveats" footnotes. Small, extensible
 * rule registry; returns `[]` when the value is clean. Only support-shaped
 * capability values currently carry caveats.
 */
export function getCapabilityCaveats(
  field: HostConfigFieldDef,
  cfg: HostConfigDtoV2
): string[] {
  const caveats: string[] = [];
  if (field.kind.kind !== "capability") return caveats;
  const value = field.read(cfg);
  if (!value || typeof value !== "object") return caveats;
  const rec = value as Record<string, unknown>;

  if (rec.listChanged === false) {
    caveats.push("Supported without list-changed notifications.");
  }
  if (field.id === "capabilities.sampling" && "tools" in rec) {
    caveats.push("Supports tool use in sampling (SEP-1577).");
  }
  if (field.id === "capabilities.experimental" && Object.keys(rec).length > 0) {
    caveats.push("Vendor / experimental — outside the core capability set.");
  }
  return caveats;
}
