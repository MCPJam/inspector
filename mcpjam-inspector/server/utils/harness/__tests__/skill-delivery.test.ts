import { describe, expect, it } from "vitest";
import { selectHarnessSkillSource } from "../skill-delivery.js";
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
    expect(source.mode !== "live" && source.skills).toEqual([
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
    expect(source.mode !== "live" && source.skills).toEqual(RESOLVED);
  });

  it("treats an EMPTY environment override as authoritative, not as absent", () => {
    // The regression this locks: falling through to `live` here would deliver
    // the whole project skill pool to a turn whose environment pinned none.
    const source = selectHarnessSkillSource({ runtimeSkillsOverride: [] });
    expect(source.mode).toBe("environment");
    expect(source.mode !== "live" && source.skills).toEqual([]);
  });

  it("treats an EMPTY pinned set as authoritative too", () => {
    const source = selectHarnessSkillSource({ pinnedHarnessSkills: [] });
    expect(source.mode).toBe("pinned");
    expect(source.mode !== "live" && source.skills).toEqual([]);
  });

  it("falls back to the live project-wide fetch only when neither is present", () => {
    expect(selectHarnessSkillSource({})).toEqual({ mode: "live" });
  });
});
