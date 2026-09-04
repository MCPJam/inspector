import { describe, expect, it } from "vitest";
import {
  bundledHostCompatCatalog,
  getCatalogHosts,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
import {
  PRESET_HOST_ID_PREFIX,
  buildPresetCompareEntries,
  demoteMcpjamHosts,
  isPresetHostId,
} from "../host-compare-presets";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

  it("uses the web deployment stamp only for MCPJam", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    const catalogMcpjamVerifiedAt = 1_000;
    const catalogSlackVerifiedAt = 2_000;
    const deployedAt = 3_000;
    catalog.hostsById.mcpjam.verifiedAt = catalogMcpjamVerifiedAt;
    catalog.hostsById.slack.verifiedAt = catalogSlackVerifiedAt;

    const { subjects } = buildPresetCompareEntries(catalog, {
      mcpjamWebDeployedAt: deployedAt,
    });

    expect(subjects[`${PRESET_HOST_ID_PREFIX}mcpjam`]?.verifiedAt).toBe(
      deployedAt,
    );
    expect(subjects[`${PRESET_HOST_ID_PREFIX}slack`]?.verifiedAt).toBe(
      catalogSlackVerifiedAt,
    );
  });

  it("uses the catalog date when no production deployment stamp exists", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    const catalogVerifiedAt = 1_000;
    catalog.hostsById.mcpjam.verifiedAt = catalogVerifiedAt;

    const { subjects } = buildPresetCompareEntries(catalog);

    expect(subjects[`${PRESET_HOST_ID_PREFIX}mcpjam`]?.verifiedAt).toBe(
      catalogVerifiedAt,
    );
  });

  it.each([
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])(
    "uses the catalog date for invalid web deployment stamp %s",
    (mcpjamWebDeployedAt) => {
      const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
      const catalogVerifiedAt = 1_000;
      catalog.hostsById.mcpjam.verifiedAt = catalogVerifiedAt;

      const { subjects } = buildPresetCompareEntries(catalog, {
        mcpjamWebDeployedAt,
      });

      expect(subjects[`${PRESET_HOST_ID_PREFIX}mcpjam`]?.verifiedAt).toBe(
        catalogVerifiedAt,
      );
    },
  );
});

describe("demoteMcpjamHosts", () => {
  // MCPJam is the emulator doing the comparing, so it should not hold one of
  // the leading chip slots — but it stays present and selectable.
  it("sends the MCPJam preset to the back", () => {
    const hosts = [
      { hostId: `${PRESET_HOST_ID_PREFIX}mcpjam` },
      { hostId: `${PRESET_HOST_ID_PREFIX}claude` },
      { hostId: `${PRESET_HOST_ID_PREFIX}chatgpt` },
    ];
    expect(demoteMcpjamHosts(hosts).map((h) => h.hostId)).toEqual([
      `${PRESET_HOST_ID_PREFIX}claude`,
      `${PRESET_HOST_ID_PREFIX}chatgpt`,
      `${PRESET_HOST_ID_PREFIX}mcpjam`,
    ]);
  });

  it("sends a LIVE MCPJam host to the back too, identified by style", () => {
    // A created host can be named anything, so the id proves nothing. This is
    // the case the preset id check alone would miss.
    const hosts = [{ hostId: "h_mine" }, { hostId: "h_other" }];
    const subjects = {
      h_mine: { hostStyle: "mcpjam" },
      h_other: { hostStyle: "claude" },
    };
    expect(demoteMcpjamHosts(hosts, subjects).map((h) => h.hostId)).toEqual([
      "h_other",
      "h_mine",
    ]);
  });

  it("leaves a live MCPJam host in place until its subject has loaded", () => {
    // Subjects arrive asynchronously. Before one does there is nothing to
    // identify the host by, so it keeps its position rather than jumping.
    const hosts = [{ hostId: "h_mine" }, { hostId: "h_other" }];
    expect(demoteMcpjamHosts(hosts, {}).map((h) => h.hostId)).toEqual([
      "h_mine",
      "h_other",
    ]);
  });

  it("keeps everything else in its original order", () => {
    const hosts = [
      { hostId: "h_a" },
      { hostId: `${PRESET_HOST_ID_PREFIX}mcpjam` },
      { hostId: "h_b" },
      { hostId: `${PRESET_HOST_ID_PREFIX}claude` },
    ];
    expect(demoteMcpjamHosts(hosts).map((h) => h.hostId)).toEqual([
      "h_a",
      "h_b",
      `${PRESET_HOST_ID_PREFIX}claude`,
      `${PRESET_HOST_ID_PREFIX}mcpjam`,
    ]);
  });

  it("does not mutate its input and returns a copy when nothing moves", () => {
    const hosts = [{ hostId: "h_a" }, { hostId: "h_b" }];
    const out = demoteMcpjamHosts(hosts);
    expect(out).not.toBe(hosts);
    expect(hosts.map((h) => h.hostId)).toEqual(["h_a", "h_b"]);
  });
});
