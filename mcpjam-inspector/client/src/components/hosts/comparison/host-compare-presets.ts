import type { HostThemeMode } from "@/lib/client-styles/types";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { HostListItem } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { HOST_TEMPLATES } from "@/lib/client-templates";

/**
 * Static host profiles surfaced in Host Compare so a user can compare against
 * Claude / ChatGPT / Cursor / Copilot / Codex … without having created (or
 * connected) those hosts — the same "best-effort host profiles" the server
 * detail modal's Hosts tab renders from `HOST_TEMPLATES`. Each preset is a
 * synthetic, immediately-available comparison subject derived from a template
 * `seed()`, never a real `hosts:listHosts` row.
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

/**
 * Build the preset selector chips + their comparison subjects from the host
 * template catalog. A template `seed()` returns a `HostConfigInputV2`, which is
 * structurally a `HostConfigDtoV2` minus the persisted `id` / `schemaVersion`
 * — the matrix only reads the shared config fields, so we stamp synthetic
 * values and use it directly instead of round-tripping through a real host.
 *
 * `theme` threads MCPJam's current theme into each seed so preset configs match
 * the rest of the app, mirroring the Hosts-tab CTA's `seedFromHostTemplate`.
 */
export function buildPresetCompareEntries(
  theme: HostThemeMode,
): PresetCompareEntries {
  const hosts: HostListItem[] = [];
  const subjects: Record<string, HostComparisonSubject> = {};

  for (const template of HOST_TEMPLATES) {
    const hostId = `${PRESET_HOST_ID_PREFIX}${template.id}`;
    const input = template.seed({ theme });
    const config: HostConfigDtoV2 = {
      ...input,
      id: hostId,
      schemaVersion: 2,
    };

    hosts.push({
      hostId,
      name: template.label,
      hostConfigId: hostId,
      modelId: config.modelId,
      serverCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    subjects[hostId] = {
      hostId,
      hostName: template.label,
      hostStyle: config.hostStyle,
      configHashShort: template.id,
      config,
    };
  }

  return { hosts, subjects };
}
