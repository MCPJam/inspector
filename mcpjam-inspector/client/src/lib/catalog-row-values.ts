/**
 * Readers that tell a catalog row's measured values from the ones its probe
 * left out, for the host-config field schema.
 */

import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { HostConfigDtoWithCatalogFacts } from "@/lib/host-config-field-schema";

/**
 * Whether a config is a catalog row: only catalog rows carry the catalog's
 * `rendersMcpApps` fact. A host a user built has none.
 */
export function isCatalogRow(cfg: HostConfigDtoV2): boolean {
  return (cfg as HostConfigDtoWithCatalogFacts).rendersMcpApps !== undefined;
}

/**
 * A catalog row that renders MCP Apps but left this value out of its
 * `mcpAppsOverrides`, because its probe did not measure it. The row reads
 * `undefined` and renders as not yet tested. The effective value would be
 * the client style's default, which is a guess about this host, not a
 * measurement. A host a user built keeps showing its effective value.
 */
export function untestedCatalogAppValue(
  cfg: HostConfigDtoV2,
  path: readonly string[],
): boolean {
  if ((cfg as HostConfigDtoWithCatalogFacts).rendersMcpApps !== true) {
    return false;
  }
  let value: unknown = cfg.mcpProfile?.apps?.mcpAppsOverrides;
  for (const key of path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value === undefined;
}

/**
 * A catalog row that stores no image policy at all (`{}` or absent), because
 * its probe did not measure image handling. A row that stores any part of
 * the policy was measured, and the policy helpers read it as written, so a
 * disabled resource type still reads as off.
 */
export function untestedCatalogImagePolicy(
  cfg: HostConfigDtoV2,
  policy: object | undefined,
): boolean {
  return (
    isCatalogRow(cfg) &&
    (policy === undefined || Object.keys(policy).length === 0)
  );
}
