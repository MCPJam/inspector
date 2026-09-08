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
  dropPresetsShadowedByLiveHosts,
  isPresetHostId,
  remapShadowedSelection,
  resolveCompareHostStyle,
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

  it("demotes an UNSELECTED live MCPJam host by name", () => {
    // The case that kept MCPJam in slot one for guests: subjects are loaded
    // only for SELECTED hosts, so an unselected live host has no hostStyle to
    // read. The name is what the chip's own logo lookup uses, so it is the
    // signal available at exactly the moment the style is not.
    const hosts = [
      { hostId: "h_mine", name: "MCPJam" },
      { hostId: "h_other", name: "My Claude" },
    ];
    expect(demoteMcpjamHosts(hosts, {}).map((h) => h.hostId)).toEqual([
      "h_other",
      "h_mine",
    ]);
  });

  it("matches the name case-insensitively and when decorated", () => {
    const hosts = [
      { hostId: "h_a", name: "mcpjam (staging)" },
      { hostId: "h_b", name: "Cursor" },
    ];
    expect(demoteMcpjamHosts(hosts).map((h) => h.hostId)).toEqual([
      "h_b",
      "h_a",
    ]);
  });

  it("leaves an unnamed host alone when no signal identifies it", () => {
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

describe("resolveCompareHostStyle", () => {
  it("reads a preset's style straight off its id", () => {
    expect(
      resolveCompareHostStyle({ hostId: `${PRESET_HOST_ID_PREFIX}claude` }),
    ).toBe("claude");
  });

  it("prefers a loaded subject's style over the name", () => {
    // A host named "Claude" running the cursor style is the case where the
    // name lies; the subject is authoritative once it exists.
    expect(
      resolveCompareHostStyle(
        { hostId: "h_a", name: "Claude" },
        { h_a: { hostStyle: "cursor" } },
      ),
    ).toBe("cursor");
  });

  it("falls back to the name when no subject has loaded", () => {
    expect(resolveCompareHostStyle({ hostId: "h_a", name: "MCPJam" })).toBe(
      "mcpjam",
    );
  });

  it("returns null when nothing identifies the host", () => {
    expect(
      resolveCompareHostStyle({ hostId: "h_a", name: "Untitled thing" }),
    ).toBeNull();
  });
});

describe("dropPresetsShadowedByLiveHosts", () => {
  // The two lists are built independently and then concatenated, so nothing
  // reconciled them: a project with an MCPJam client showed both it and
  // `preset:mcpjam`, same name and same logo.
  it("drops the preset a live host already covers", () => {
    const live = [{ hostId: "h_mine", name: "MCPJam" }];
    const presets = [
      { hostId: `${PRESET_HOST_ID_PREFIX}mcpjam`, name: "MCPJam" },
      { hostId: `${PRESET_HOST_ID_PREFIX}claude`, name: "Claude" },
    ];
    expect(
      dropPresetsShadowedByLiveHosts(live, presets).map((h) => h.hostId),
    ).toEqual([`${PRESET_HOST_ID_PREFIX}claude`]);
  });

  it("keeps every preset when the user owns none of them", () => {
    const presets = [
      { hostId: `${PRESET_HOST_ID_PREFIX}mcpjam`, name: "MCPJam" },
      { hostId: `${PRESET_HOST_ID_PREFIX}claude`, name: "Claude" },
    ];
    expect(dropPresetsShadowedByLiveHosts([], presets)).toHaveLength(2);
  });

  it("matches on the live host's STYLE, not its name", () => {
    // A client named "My Editor" running the cursor style still shadows the
    // Cursor preset. The name would never have matched.
    const live = [{ hostId: "h_a", name: "My Editor" }];
    const presets = [
      { hostId: `${PRESET_HOST_ID_PREFIX}cursor`, name: "Cursor" },
      { hostId: `${PRESET_HOST_ID_PREFIX}claude`, name: "Claude" },
    ];
    expect(
      dropPresetsShadowedByLiveHosts(live, presets, {
        h_a: { hostStyle: "cursor" },
      }).map((h) => h.hostId),
    ).toEqual([`${PRESET_HOST_ID_PREFIX}claude`]);
  });

  it("leaves presets alone when a live host identifies as nothing", () => {
    const live = [{ hostId: "h_a", name: "Untitled thing" }];
    const presets = [{ hostId: `${PRESET_HOST_ID_PREFIX}claude`, name: "C" }];
    expect(dropPresetsShadowedByLiveHosts(live, presets)).toHaveLength(1);
  });
});

describe("resolveCompareHostStyle signal order", () => {
  it("prefers the list query's own hostStyle over subject and name", () => {
    // The stored style is available for EVERY host, selected or not, which is
    // what makes shadowing independent of selection.
    expect(
      resolveCompareHostStyle(
        { hostId: "h_a", name: "Claude", hostStyle: "agentcore" },
        { h_a: { hostStyle: "cursor" } },
      ),
    ).toBe("agentcore");
  });

  it("resolves an exact style name the hint table never lists", () => {
    // `codex`, `agentcore` and `n8n` are absent from LOGO_NAME_HINTS; only the
    // exact-name pass places them, and the logo resolver has always run both.
    expect(resolveCompareHostStyle({ hostId: "h_a", name: "Codex" })).toBe(
      "codex",
    );
    expect(resolveCompareHostStyle({ hostId: "h_b", name: "AgentCore" })).toBe(
      "agentcore",
    );
  });
});

describe("remapShadowedSelection", () => {
  const live = [{ hostId: "h_mine", name: "Claude", hostStyle: "claude" }];

  it("points a selected preset at the live host that shadowed it", () => {
    expect(
      remapShadowedSelection(
        [`${PRESET_HOST_ID_PREFIX}chatgpt`, `${PRESET_HOST_ID_PREFIX}claude`],
        live,
      ),
    ).toEqual([`${PRESET_HOST_ID_PREFIX}chatgpt`, "h_mine"]);
  });

  it("leaves presets with no live counterpart alone", () => {
    expect(
      remapShadowedSelection([`${PRESET_HOST_ID_PREFIX}cursor`], live),
    ).toEqual([`${PRESET_HOST_ID_PREFIX}cursor`]);
  });

  it("does not duplicate a live host already in the selection", () => {
    expect(
      remapShadowedSelection(
        ["h_mine", `${PRESET_HOST_ID_PREFIX}claude`],
        live,
      ),
    ).toEqual(["h_mine"]);
  });

  it("picks the host that owns the unsuffixed name, not the first in the array", () => {
    // The list query returns rows in index order, while display names are
    // allocated oldest-first. When the two disagree, taking the array's first
    // host pointed the upgraded column at the client labeled "Claude #2".
    const outOfOrder = [
      { hostId: "h_new", name: "Claude", hostStyle: "claude", createdAt: 200 },
      { hostId: "h_old", name: "Claude", hostStyle: "claude", createdAt: 100 },
    ];
    expect(
      remapShadowedSelection([`${PRESET_HOST_ID_PREFIX}claude`], outOfOrder),
    ).toEqual(["h_old"]);
  });

  it("breaks a createdAt tie by id, the same way display names do", () => {
    const tied = [
      { hostId: "h_b", name: "Claude", hostStyle: "claude", createdAt: 100 },
      { hostId: "h_a", name: "Claude", hostStyle: "claude", createdAt: 100 },
    ];
    expect(
      remapShadowedSelection([`${PRESET_HOST_ID_PREFIX}claude`], tied),
    ).toEqual(["h_a"]);
  });

  it("is a no-op when the user owns nothing", () => {
    const selection = [`${PRESET_HOST_ID_PREFIX}claude`];
    expect(remapShadowedSelection(selection, [])).toEqual(selection);
  });
});
