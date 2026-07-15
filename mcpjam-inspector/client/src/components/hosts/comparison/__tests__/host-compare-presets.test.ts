import { describe, expect, it } from "vitest";
import {
  bundledHostCompatCatalog,
  getCatalogHosts,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
import {
  PRESET_HOST_ID_PREFIX,
  buildPresetCompareEntries,
  isPresetHostId,
} from "../host-compare-presets";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("host-compare-presets", () => {
  it("builds one preset host + subject per catalog host, in catalog order", () => {
    const catalog = bundledHostCompatCatalog();
    const catalogHosts = getCatalogHosts(catalog);
    const { hosts, subjects } = buildPresetCompareEntries(catalog);

    expect(hosts).toHaveLength(catalogHosts.length);
    expect(hosts.map((h) => h.hostId)).toEqual(
      catalogHosts.map((host) => `${PRESET_HOST_ID_PREFIX}${host.id}`),
    );
    // Every preset host has a matching, immediately-available subject.
    for (const host of hosts) {
      const subject = subjects[host.hostId];
      expect(subject).toBeDefined();
      expect(subject.hostName).toBe(host.name);
      expect(subject.config.modelId).toBe(host.modelId);
      // Synthetic DTO fields the matrix never reads but must be present.
      expect(subject.config.id).toBe(host.hostId);
    }
  });

  it("marks every preset id and rejects a real Convex id", () => {
    const { hosts } = buildPresetCompareEntries(bundledHostCompatCatalog());
    expect(hosts.every((h) => isPresetHostId(h.hostId))).toBe(true);
    expect(isPresetHostId("k1234567890abcdef")).toBe(false);
  });

  it("omits excluded gated templates", () => {
    const { hosts, subjects } = buildPresetCompareEntries(
      bundledHostCompatCatalog(),
      {
        excludedTemplateIds: new Set(["claude-code"]),
      },
    );

    const hostIds = hosts.map((h) => h.hostId);
    expect(hostIds).not.toContain(`${PRESET_HOST_ID_PREFIX}claude-code`);
    expect(hostIds).toContain(`${PRESET_HOST_ID_PREFIX}codex`);
    expect(subjects[`${PRESET_HOST_ID_PREFIX}claude-code`]).toBeUndefined();
    expect(subjects[`${PRESET_HOST_ID_PREFIX}codex`]).toBeDefined();
  });

  it("uses catalog labels and configs for preset subjects", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    catalog.hostsById.slack.label = "Slack";

    const { hosts, subjects } = buildPresetCompareEntries(catalog);
    const hostId = `${PRESET_HOST_ID_PREFIX}slack`;
    const host = hosts.find((h) => h.hostId === hostId);
    expect(host?.name).toBe("Slack");
    expect(subjects[hostId]?.hostName).toBe("Slack");
    expect(subjects[hostId]?.config.hostStyle).toBe("slack");
    expect(subjects[hostId]?.config.mcpProfile).toEqual(
      catalog.hostsById.slack.mcpProfile,
    );
  });
});
