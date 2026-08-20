import type { HostConfigDtoWithCatalogFacts } from "@/lib/host-config-field-schema";
import type { HostListItem } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import {
  getCatalogHosts,
  getCatalogTemplate,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";

/**
 * Static host profiles surfaced in Host Compare so a user can compare against
 * Claude / ChatGPT / Cursor / Copilot / Codex … without having created (or
 * connected) those hosts. Each preset is a synthetic, immediately-available
 * comparison subject derived from the catalog host row, never a real
 * `hosts:listHosts` row.
 */

/** Prefix that marks a synthetic preset host id (`preset:claude`, …). Chosen so
 * it can never collide with a Convex host id. */
export const PRESET_HOST_ID_PREFIX = "preset:";

export function isPresetHostId(hostId: string): boolean {
  return hostId.startsWith(PRESET_HOST_ID_PREFIX);
}

export interface PresetCompareEntries {
  /** Selector chips, in template order, appended after the real hosts. */
  hosts: HostListItem[];
  /** Ready-to-render subjects keyed by preset host id — no fetch required. */
  subjects: Record<string, HostComparisonSubject>;
}

interface PresetCompareOptions {
  excludedTemplateIds?: ReadonlySet<string>;
}

/**
 * Build the preset selector chips + their comparison subjects from the live
 * host catalog. The matrix reads the same host object used for creation/update,
 * with only synthetic persisted fields stamped on for comparison.
 */
export function buildPresetCompareEntries(
  catalog: HostCompatCatalog,
  options: PresetCompareOptions = {}
): PresetCompareEntries {
  const hosts: HostListItem[] = [];
  const subjects: Record<string, HostComparisonSubject> = {};

  for (const host of getCatalogHosts(catalog)) {
    if (options.excludedTemplateIds?.has(host.id)) continue;

    const hostId = `${PRESET_HOST_ID_PREFIX}${host.id}`;
    const input = getCatalogTemplate(catalog, host.id);
    if (!input) continue;
    const config: HostConfigDtoWithCatalogFacts = {
      ...input,
      id: hostId,
      schemaVersion: 2,
      // The catalog row knows every era the client speaks; the template's
      // `initialize` list only carries the legacy ones. Carry the catalog
      // fact so the comparison shows real support, not the handshake list.
      supportedProtocolVersions: host.supportedProtocolVersions,
      // Lets a row distinguish "probed and absent" from "never probed".
      provenance: host.provenance,
      // Lets the display-mode rows stay blank for a host that shows no
      // widgets at all, instead of printing the no-claims filler.
      rendersMcpApps: host.rendersMcpApps,
      // Both style themes for hosts that resolve their tokens per theme;
      // hostContext.styles can only carry the one the host announces.
      styleVariablesByTheme: host.styleVariablesByTheme,
    } as HostConfigDtoWithCatalogFacts;

    hosts.push({
      hostId,
      name: host.label,
      hostConfigId: hostId,
      modelId: config.modelId,
      serverCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    subjects[hostId] = {
      hostId,
      hostName: host.label,
      hostStyle: config.hostStyle,
      configHashShort: host.id,
      verifiedAt: host.verifiedAt,
      config,
    };
  }

  return { hosts, subjects };
}
