import type { HostConfigDtoWithCatalogFacts } from "@/lib/host-config-field-schema";
import type { HostListItem } from "@/hooks/useClients";
import { resolveHostStyleByName } from "@/lib/host-logo";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import {
  getCatalogHosts,
  getCatalogTemplate,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
import { MCPJAM_WEB_DEPLOYED_AT } from "@/generated/mcpjam-web-deployed-at";
import { resolveVerifiedAt } from "../verified-at";

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
  mcpjamWebDeployedAt?: number | null;
}

/**
 * Build the preset selector chips + their comparison subjects from the live
 * host catalog. The matrix reads the same host object used for creation/update,
 * with only synthetic persisted fields stamped on for comparison.
 */
export function buildPresetCompareEntries(
  catalog: HostCompatCatalog,
  options: PresetCompareOptions = {},
): PresetCompareEntries {
  const hosts: HostListItem[] = [];
  const subjects: Record<string, HostComparisonSubject> = {};
  const mcpjamWebDeployedAt =
    options.mcpjamWebDeployedAt === undefined
      ? MCPJAM_WEB_DEPLOYED_AT
      : options.mcpjamWebDeployedAt;

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
      displayName: host.label,
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
      verifiedAt: resolveVerifiedAt(
        host.id,
        host.verifiedAt,
        mcpjamWebDeployedAt,
      ),
      config,
    };
  }

  return { hosts, subjects };
}

/**
 * Move MCPJam's own row out of the leading chips without removing it.
 *
 * MCPJam is the emulator doing the comparing, so it should not occupy one of
 * the inline chip slots reserved for the clients you are actually comparing —
 * but it stays selectable, on both surfaces.
 *
 * Three signals, because no single one covers every case:
 *
 * - `preset:mcpjam` — the catalog row. Exact, always available.
 * - `subjectsByHost[id].hostStyle` — the truth for a live host, but subjects
 *   are only loaded for SELECTED hosts, so an unselected one has none.
 * - the host NAME — the fallback that covers exactly that gap. It is the same
 *   signal `resolveHostLogoByName` already uses to draw the chip's logo, so a
 *   chip showing the MCPJam mark and a chip being demoted agree by
 *   construction.
 *
 * Stable: everything else keeps its relative order.
 */
export function demoteMcpjamHosts<
  T extends Pick<HostListItem, "hostId"> & { name?: string },
>(
  hosts: ReadonlyArray<T>,
  subjectsByHost: Readonly<Record<string, { hostStyle?: string }>> = {},
): T[] {
  const isMcpjam = (host: T) =>
    host.hostId === `${PRESET_HOST_ID_PREFIX}mcpjam` ||
    subjectsByHost[host.hostId]?.hostStyle === "mcpjam" ||
    (host.name !== undefined && /mcpjam/i.test(host.name));
  const rest = hosts.filter((host) => !isMcpjam(host));
  if (rest.length === hosts.length) return [...hosts];
  return [...rest, ...hosts.filter(isMcpjam)];
}

/**
 * The catalog host id a compare entry stands for, or `null` when nothing
 * identifies it.
 *
 * Three signals, strongest first. A preset carries the id in its own hostId. A
 * live host's style is authoritative but only exists once its subject has
 * loaded, and subjects load for SELECTED hosts only. The name is the fallback
 * that covers the gap — and it is the same signal the chip's own logo lookup
 * uses, so what a row looks like and what it is treated as cannot disagree.
 */
export function resolveCompareHostStyle(
  host: Pick<HostListItem, "hostId"> & { name?: string },
  subjectsByHost: Readonly<Record<string, { hostStyle?: string }>> = {},
): string | null {
  if (isPresetHostId(host.hostId)) {
    return host.hostId.slice(PRESET_HOST_ID_PREFIX.length);
  }
  const style = subjectsByHost[host.hostId]?.hostStyle;
  if (style) return style;
  return host.name ? resolveHostStyleByName(host.name) : null;
}

/**
 * Drop the catalog preset for any host style the user already has a real client
 * for.
 *
 * The two lists are built independently — `useHostList` for live hosts,
 * `buildPresetCompareEntries` for the catalog — and then concatenated, so
 * nothing reconciled them. A project with an MCPJam client got both it and
 * `preset:mcpjam`, two rows with the same name and logo and no way to tell them
 * apart.
 *
 * The live host wins: it is the one the user can edit, select and verify
 * against. The preset is a read-only stand-in for a client you do NOT have.
 */
export function dropPresetsShadowedByLiveHosts<
  T extends Pick<HostListItem, "hostId"> & { name?: string },
>(
  liveHosts: ReadonlyArray<T>,
  presets: ReadonlyArray<T>,
  subjectsByHost: Readonly<Record<string, { hostStyle?: string }>> = {},
): T[] {
  const covered = new Set(
    liveHosts
      .map((host) => resolveCompareHostStyle(host, subjectsByHost))
      .filter((style): style is string => style !== null),
  );
  if (covered.size === 0) return [...presets];
  return presets.filter(
    (preset) => !covered.has(resolveCompareHostStyle(preset, subjectsByHost)!),
  );
}
