import { describe, expect, it } from "vitest";
import {
  composeLivePlusSkills,
  selectHarnessSkillSource,
  withoutLivePluginVersions,
  type LivePluginDelivery,
} from "../skill-delivery.js";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities.js";
import type { RuntimeSkill } from "../runtime-skills.js";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types.js";

const PINNED: PinnedSkillArtifact[] = [
  {
    skillId: "sk_pinned",
    name: "pinned-skill",
    description: "frozen",
    content: "frozen body",
    contentHash: "hash_pinned",
  },
];

const RESOLVED: RuntimeSkill[] = [
  {
    skillId: "sk_env",
    name: "env-skill",
    description: "resolved",
    content: "resolved body",
    aggregateHash: "hash_env",
  },
];

describe("selectHarnessSkillSource", () => {
  it("prefers frozen run artifacts over an environment override", () => {
    // Reproducibility outranks live resolution: a pinned run must re-execute
    // identically, so nothing live may be consulted — not even an environment.
    const source = selectHarnessSkillSource({
      pinnedHarnessSkills: PINNED,
      runtimeSkillsOverride: RESOLVED,
    });
    expect(source.mode).toBe("pinned");
    expect("skills" in source && source.skills).toEqual([
      {
        skillId: "sk_pinned",
        name: "pinned-skill",
        description: "frozen",
        content: "frozen body",
        aggregateHash: "hash_pinned",
      },
    ]);
  });

  it("uses the environment override when there is no pinned set", () => {
    const source = selectHarnessSkillSource({
      runtimeSkillsOverride: RESOLVED,
    });
    expect(source.mode).toBe("environment");
    expect("skills" in source && source.skills).toEqual(RESOLVED);
  });

  it("treats an EMPTY environment override as authoritative, not as absent", () => {
    // The regression this locks: falling through to `live` here would deliver
    // the whole project skill pool to a turn whose environment pinned none.
    const source = selectHarnessSkillSource({ runtimeSkillsOverride: [] });
    expect(source.mode).toBe("environment");
    expect("skills" in source && source.skills).toEqual([]);
  });

  it("treats an EMPTY pinned set as authoritative too", () => {
    const source = selectHarnessSkillSource({ pinnedHarnessSkills: [] });
    expect(source.mode).toBe("pinned");
    expect("skills" in source && source.skills).toEqual([]);
  });

  it("falls back to the live project-wide fetch only when neither is present", () => {
    expect(selectHarnessSkillSource({})).toEqual({ mode: "live" });
  });

  it("selects live_plus only from the explicit live-plugins input", () => {
    const plugins = livePlugins([
      { id: "sk_p", name: "keycaps", version: "pv_a" },
    ]);
    expect(selectHarnessSkillSource({ livePlugins: plugins })).toEqual({
      mode: "live_plus",
      plugins,
    });
    // An environment (or a pinned run) still outranks it.
    expect(
      selectHarnessSkillSource({
        runtimeSkillsOverride: RESOLVED,
        livePlugins: plugins,
      }).mode,
    ).toBe("environment");
  });
});

const PLUGIN_A = {
  pluginId: "p_a",
  pluginVersionId: "pv_a",
  name: "alpha",
  bundleHash: "hash_a",
};
const PLUGIN_B = {
  pluginId: "p_b",
  pluginVersionId: "pv_b",
  name: "beta",
  bundleHash: "hash_b",
};

function livePlugins(
  skills: Array<{ id: string; name: string; version: "pv_a" | "pv_b" }>,
): LivePluginDelivery {
  const plugin = (version: string) =>
    version === "pv_a" ? PLUGIN_A : PLUGIN_B;
  const capabilities = resolveEffectiveCapabilities(
    {
      servers: {
        effectiveServerIds: ["ps_a"],
        pluginServerIds: ["ps_a"],
        connectable: [{ serverId: "ps_a", name: "a", source: "plugin" }],
      },
      skills: skills.map((skill) => ({
        skillId: skill.id,
        name: skill.name,
        description: "",
        content: `${skill.name} body`,
        aggregateHash: `agg_${skill.id}`,
        channels: ["plugin" as const],
        files: [{ path: "ref.md", size: 1, url: `https://signed/${skill.id}` }],
      })),
      pluginVersions: [PLUGIN_A, PLUGIN_B],
    },
    {
      serverOrigins: new Map([["ps_a", PLUGIN_A]]),
      skillOrigins: new Map(
        skills.map((skill) => [
          skill.id,
          {
            modelRef: `${plugin(skill.version).name}/${skill.name}`,
            plugin: plugin(skill.version),
          },
        ]),
      ),
      unattributedVersionIds: [],
    },
  );
  return {
    skills: skills.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      description: "",
      content: `${skill.name} body`,
      aggregateHash: `agg_${skill.id}`,
    })),
    capabilities,
  };
}

const STANDALONE: RuntimeSkill[] = [
  {
    skillId: "sk_notes",
    name: "notes",
    description: "",
    content: "standalone body",
    aggregateHash: "agg_notes",
  },
];

describe("composeLivePlusSkills", () => {
  it("delivers the standalone skills, then the plugin skills", () => {
    const composed = composeLivePlusSkills(
      STANDALONE,
      livePlugins([{ id: "sk_p", name: "keycaps", version: "pv_a" }]),
    );
    expect(composed.skills?.map((skill) => skill.name)).toEqual([
      "notes",
      "keycaps",
    ]);
    expect([...composed.pluginSkillIds]).toEqual(["sk_p"]);
    expect(composed.problems).toEqual([]);
  });

  it("knows nothing when the live fetch failed, so delivers nothing new", () => {
    const composed = composeLivePlusSkills(
      null,
      livePlugins([{ id: "sk_p", name: "keycaps", version: "pv_a" }]),
    );
    expect(composed.skills).toBeNull();
    expect(composed.pluginSkillIds.size).toBe(0);
  });

  it("drops a plugin skill whose box folder a standalone or earlier plugin skill holds", () => {
    const composed = composeLivePlusSkills(
      STANDALONE,
      livePlugins([
        { id: "sk_p1", name: "notes", version: "pv_a" },
        { id: "sk_p2", name: "keycaps", version: "pv_a" },
        { id: "sk_p3", name: "keycaps", version: "pv_b" },
      ]),
    );
    expect(composed.skills?.map((skill) => skill.skillId)).toEqual([
      "sk_notes",
      "sk_p2",
    ]);
    expect(composed.problems).toEqual([
      { code: "skill_folder_collision", skillId: "sk_p1", name: "notes" },
      { code: "skill_folder_collision", skillId: "sk_p3", name: "keycaps" },
    ]);
  });
});

describe("withoutLivePluginVersions", () => {
  it("removes a skipped plugin's skills, servers and version together", () => {
    const narrowed = withoutLivePluginVersions(
      livePlugins([
        { id: "sk_a", name: "from-a", version: "pv_a" },
        { id: "sk_b", name: "from-b", version: "pv_b" },
      ]),
      new Set(["pv_a"]),
    );
    expect(narrowed.skills.map((skill) => skill.skillId)).toEqual(["sk_b"]);
    expect(
      narrowed.capabilities.pluginSkills.map((skill) => skill.skillId),
    ).toEqual(["sk_b"]);
    expect(narrowed.capabilities.pluginServerIds).toEqual([]);
    expect(
      narrowed.capabilities.pluginVersions.map((v) => v.pluginVersionId),
    ).toEqual(["pv_b"]);
  });
});
