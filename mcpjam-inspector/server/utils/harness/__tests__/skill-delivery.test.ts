import { describe, expect, it } from "vitest";
import {
  composeLivePlusSkills,
  selectHarnessSkillSource,
} from "../skill-delivery.js";
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

  it("selects live_plus only from the explicit input, on top of an environment override", () => {
    expect(
      selectHarnessSkillSource({
        runtimeSkillsOverride: RESOLVED,
        includeProjectSkills: true,
      }),
    ).toEqual({ mode: "live_plus", environmentSkills: RESOLVED });
    // An empty environment still adds the pool: the turn stands in for a
    // client turn, which delivers it.
    expect(
      selectHarnessSkillSource({
        runtimeSkillsOverride: [],
        includeProjectSkills: true,
      }),
    ).toEqual({ mode: "live_plus", environmentSkills: [] });
    // A pinned run still outranks it.
    expect(
      selectHarnessSkillSource({
        pinnedHarnessSkills: PINNED,
        runtimeSkillsOverride: RESOLVED,
        includeProjectSkills: true,
      }).mode,
    ).toBe("pinned");
    // Without an environment there is nothing to add: the plain live fetch.
    expect(selectHarnessSkillSource({ includeProjectSkills: true })).toEqual({
      mode: "live",
    });
    // An environment override alone is never read as live_plus.
    expect(
      selectHarnessSkillSource({ runtimeSkillsOverride: RESOLVED }).mode,
    ).toBe("environment");
  });
});

function skill(skillId: string, name: string): RuntimeSkill {
  return {
    skillId,
    name,
    description: "",
    content: `${name} body`,
    aggregateHash: `agg_${skillId}`,
  };
}

describe("composeLivePlusSkills", () => {
  it("delivers the environment's skills, then the project's pool", () => {
    const composed = composeLivePlusSkills(
      [skill("sk_notes", "notes")],
      [skill("sk_plugin", "keycaps"), skill("sk_host", "release-notes")],
    );
    expect(composed.skills?.map((entry) => entry.skillId)).toEqual([
      "sk_plugin",
      "sk_host",
      "sk_notes",
    ]);
    expect([...composed.environmentSkillIds]).toEqual(["sk_plugin", "sk_host"]);
    expect([...composed.projectSkillIds]).toEqual(["sk_notes"]);
    expect(composed.problems).toEqual([]);
  });

  it("does not add a project skill the environment already carries", () => {
    // The client selected it, so it arrived on the host channel: the same
    // skill, delivered once, as the environment's.
    const composed = composeLivePlusSkills(
      [skill("sk_host", "release-notes"), skill("sk_notes", "notes")],
      [skill("sk_host", "release-notes")],
    );
    expect(composed.skills?.map((entry) => entry.skillId)).toEqual([
      "sk_host",
      "sk_notes",
    ]);
    expect([...composed.environmentSkillIds]).toEqual(["sk_host"]);
    expect([...composed.projectSkillIds]).toEqual(["sk_notes"]);
    expect(composed.problems).toEqual([]);
  });

  it("knows nothing when the live fetch failed, so delivers nothing new", () => {
    const composed = composeLivePlusSkills(null, [
      skill("sk_plugin", "keycaps"),
    ]);
    expect(composed.skills).toBeNull();
    expect(composed.environmentSkillIds.size).toBe(0);
    expect(composed.projectSkillIds.size).toBe(0);
  });

  it("keeps the environment's skill when two want one box folder, and reports the other", () => {
    const composed = composeLivePlusSkills(
      [skill("sk_personal", "keycaps"), skill("sk_notes", "notes")],
      [skill("sk_plugin_a", "keycaps"), skill("sk_plugin_b", "keycaps")],
    );
    expect(composed.skills?.map((entry) => entry.skillId)).toEqual([
      "sk_plugin_a",
      "sk_notes",
    ]);
    expect(composed.problems).toEqual([
      {
        code: "skill_folder_collision",
        skillId: "sk_plugin_b",
        name: "keycaps",
      },
      {
        code: "skill_folder_collision",
        skillId: "sk_personal",
        name: "keycaps",
      },
    ]);
    expect(composed.projectSkillIds.has("sk_personal")).toBe(false);
  });
});
