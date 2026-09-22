// INS-5 — a run's plugin surface must come from the run's own snapshot.
//
// The cases below are the three ways that stops being true: addressing a plugin
// skill by its (non-unique) name, reading an unreachable pinned blob as "no
// file", and re-deriving the version list from something other than the record.

import { describe, expect, it } from "vitest";
import {
  RunPluginSnapshotError,
  assertPinnedSkillFilesReachable,
  buildRunCapabilitySet,
  runNeedsEffectiveSkillSurface,
  runPluginVersions,
  type RunPinnedSkill,
} from "../run-plugin-snapshot.js";
import type { RunPluginServer } from "../../plugins/run-plugin-servers.js";

const ACME = {
  pluginId: "p_acme",
  pluginVersionId: "pv_acme_1",
  name: "acme",
  bundleHash: "a".repeat(64),
};
const BETA = {
  pluginId: "p_beta",
  pluginVersionId: "pv_beta_1",
  name: "beta",
  bundleHash: "b".repeat(64),
};

function pin(overrides: Partial<RunPinnedSkill> = {}): RunPinnedSkill {
  return {
    skillId: "sk1",
    name: "summarize",
    description: "d",
    content: "body",
    contentHash: "c1",
    ...overrides,
  };
}

function server(overrides: Partial<RunPluginServer> = {}): RunPluginServer {
  return {
    serverId: "srv_acme",
    name: "acme-api",
    pluginVersionId: ACME.pluginVersionId,
    pluginId: ACME.pluginId,
    pluginName: ACME.name,
    componentKey: "api",
    ...overrides,
  };
}

describe("assertPinnedSkillFilesReachable", () => {
  it("passes a body-only pin", () => {
    expect(() => assertPinnedSkillFilesReachable([pin()])).not.toThrow();
  });

  it("passes when every pinned file has a signed url", () => {
    expect(() =>
      assertPinnedSkillFilesReachable([
        pin({
          files: [
            { path: "scripts/run.py", contentHash: "f1", size: 10, url: "u" },
          ],
        }),
      ])
    ).not.toThrow();
  });

  // THE inversion this module exists to prevent. `url: null` means the pinned
  // blob is gone; reading it as "this skill has no scripts" replays the run
  // with the assets missing and still reports the skill as delivered.
  it("fails the run on a null url instead of reading it as 'no file'", () => {
    expect(() =>
      assertPinnedSkillFilesReachable([
        pin({
          modelRef: "acme/summarize",
          files: [
            {
              path: "scripts/run.py",
              contentHash: "f1",
              size: 10,
              url: null,
            },
          ],
        }),
      ])
    ).toThrow(RunPluginSnapshotError);
  });

  it("names the skill ref and the path so the failure is attributable", () => {
    try {
      assertPinnedSkillFilesReachable([
        pin({
          modelRef: "acme/summarize",
          files: [
            { path: "scripts/run.py", contentHash: "f1", size: 10, url: null },
          ],
        }),
      ]);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunPluginSnapshotError);
      expect((error as RunPluginSnapshotError).component).toBe(
        "acme/summarize"
      );
      expect((error as Error).message).toMatch(/scripts\/run\.py/);
    }
  });

  // The pin store is shared with file-bearing STANDALONE skills, and an
  // unreachable blob is exactly as wrong there.
  it("applies to standalone pins too", () => {
    expect(() =>
      assertPinnedSkillFilesReachable([
        pin({
          files: [
            { path: "refs/notes.md", contentHash: "f1", size: 4, url: "" },
          ],
        }),
      ])
    ).toThrow(RunPluginSnapshotError);
  });
});

describe("runNeedsEffectiveSkillSurface", () => {
  it("switches surfaces for a captured MCP-server skill", () => {
    expect(
      runNeedsEffectiveSkillSurface([
        pin({ serverSkillId: "server_skill_1", channels: ["mcp-server"] }),
      ])
    ).toBe(true);
  });

  it("keeps the legacy bare-name surface for body-only pins", () => {
    expect(runNeedsEffectiveSkillSurface([pin(), pin({ skillId: "sk2" })])).toBe(
      false
    );
  });

  it("switches surfaces for a plugin ref (a bare name cannot identify one)", () => {
    expect(
      runNeedsEffectiveSkillSurface([pin({ modelRef: "acme/summarize" })])
    ).toBe(true);
  });

  it("switches surfaces for supporting files (no bare-name tool reads them)", () => {
    expect(
      runNeedsEffectiveSkillSurface([
        pin({
          files: [
            { path: "scripts/run.py", contentHash: "f1", size: 1, url: "u" },
          ],
        }),
      ])
    ).toBe(true);
  });

  // Deploy skew: a plugin-channel pin from a backend that predates `modelRef`.
  it("switches surfaces on the plugin channel alone", () => {
    expect(runNeedsEffectiveSkillSurface([pin({ channels: ["plugin"] })])).toBe(
      true
    );
  });
});

describe("buildRunCapabilitySet", () => {
  it("keeps captured MCP-server pins out of plugin attribution", () => {
    const set = buildRunCapabilitySet({
      pins: [
        pin({
          serverSkillId: "server_skill_1",
          serverSkillVersionId: "version_1",
          serverId: "server_1",
          serverLabel: "Acme Billing",
          skillUri: "skill://acme/refunds/SKILL.md",
          serverSkillVersionNumber: 2,
          serverSkillCapturedAt: 10,
          modelRef: "acme/refunds",
          channels: ["mcp-server"],
        }),
      ],
      pluginVersions: [],
      pluginServers: [],
      effectiveServerIds: ["server_1"],
    });
    expect(set.serverSkills).toMatchObject([
      { ref: "acme/refunds", serverLabel: "Acme Billing", versionNumber: 2 },
    ]);
    expect(set.pluginSkills).toEqual([]);
  });

  it("addresses plugin skills by modelRef, so two plugins may share a name", () => {
    const set = buildRunCapabilitySet({
      pins: [
        pin({ skillId: "sk1", modelRef: "acme/summarize", channels: ["plugin"] }),
        pin({ skillId: "sk2", modelRef: "beta/summarize", channels: ["plugin"] }),
      ],
      pluginVersions: [ACME, BETA],
      pluginServers: [],
      effectiveServerIds: [],
    });
    expect(set.pluginSkills.map((s) => s.ref)).toEqual([
      "acme/summarize",
      "beta/summarize",
    ]);
    // Both survive: keyed by name they would have collided and one would be
    // unreachable — the collision BE-5 re-keyed its own gate to allow.
    expect(set.problems).toEqual([]);
  });

  it("carries the pinned bundleHash onto each skill's plugin origin", () => {
    const set = buildRunCapabilitySet({
      pins: [pin({ modelRef: "acme/summarize", channels: ["plugin"] })],
      pluginVersions: [ACME],
      pluginServers: [],
      effectiveServerIds: [],
    });
    expect(set.pluginSkills[0]?.plugin?.bundleHash).toBe(ACME.bundleHash);
  });

  it("classifies servers from the D2 answer, not from the snapshot", () => {
    const set = buildRunCapabilitySet({
      pins: [],
      pluginVersions: [ACME],
      pluginServers: [server()],
      effectiveServerIds: ["srv_host", "srv_acme"],
      serverNames: ["host-api", "ignored"],
    });
    expect(set.explicitServerIds).toEqual(["srv_host"]);
    expect(set.pluginServerIds).toEqual(["srv_acme"]);
    expect(set.servers[1]?.plugin?.pluginVersionId).toBe(ACME.pluginVersionId);
    // The D2 row's live name wins over a stale index-aligned launch name.
    expect(set.servers[1]?.name).toBe("acme-api");
  });

  it("reports a pinned version nothing attributed to, rather than staying silent", () => {
    const set = buildRunCapabilitySet({
      pins: [],
      pluginVersions: [ACME, BETA],
      pluginServers: [server()],
      effectiveServerIds: ["srv_acme"],
    });
    expect(set.problems.map((p) => p.code)).toEqual([
      "plugin_origin_unavailable",
    ]);
  });

  // Provenance is exact and immutable. Nothing here may swap in the plugin's
  // current active version.
  it("returns the pinned versions verbatim, in pin order", () => {
    expect(runPluginVersions([BETA, ACME])).toEqual([
      { ...BETA, bundleHash: BETA.bundleHash },
      { ...ACME, bundleHash: ACME.bundleHash },
    ]);
  });

  it("reports a missing bundleHash as null rather than synthesizing one", () => {
    const [only] = runPluginVersions([
      { pluginId: "p", pluginVersionId: "pv", name: "n" },
    ]);
    expect(only.bundleHash).toBeNull();
  });

  it("uses aggregateHash as the artifact identity, falling back to contentHash", () => {
    const set = buildRunCapabilitySet({
      pins: [
        pin({ skillId: "sk1", aggregateHash: "agg1" }),
        pin({ skillId: "sk2", name: "other" }),
      ],
      pluginVersions: [],
      pluginServers: [],
      effectiveServerIds: [],
    });
    expect(set.standaloneSkills.map((s) => s.aggregateHash)).toEqual([
      "agg1",
      "c1",
    ]);
  });

  it("passes pinned file urls through untouched for the ref-addressed tools", () => {
    const set = buildRunCapabilitySet({
      pins: [
        pin({
          modelRef: "acme/summarize",
          channels: ["plugin"],
          files: [
            { path: "scripts/run.py", contentHash: "f1", size: 3, url: "u1" },
          ],
        }),
      ],
      pluginVersions: [ACME],
      pluginServers: [],
      effectiveServerIds: [],
    });
    expect(set.pluginSkills[0]?.files).toEqual([
      { path: "scripts/run.py", size: 3, url: "u1" },
    ]);
  });

  // Pre-BE-5 pins carry no skillId. Keying attribution and collisions by
  // `undefined` would collapse every such pin onto one entry.
  it("gives an id-less legacy pin a stable stand-in id", () => {
    const set = buildRunCapabilitySet({
      pins: [
        pin({ skillId: undefined, name: "a" }),
        pin({ skillId: undefined, name: "b" }),
      ],
      pluginVersions: [],
      pluginServers: [],
      effectiveServerIds: [],
    });
    expect(set.standaloneSkills.map((s) => s.skillId)).toEqual([
      "pin:a",
      "pin:b",
    ]);
  });
});
