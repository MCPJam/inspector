import { describe, expect, it } from "vitest";
import { buildLiveEffectiveCapabilities } from "../../../services/environments/effective-capabilities.js";
import type { TurnSkills } from "../../../services/environments/turn-skills.js";
import { harnessTurnSkillsFromPlan } from "../skill-delivery.js";
import { skillsFingerprint, type RuntimeSkill } from "../runtime-skills.js";

const SKILL: RuntimeSkill = {
  skillId: "sk_env",
  name: "env-skill",
  description: "resolved",
  content: "resolved body",
  aggregateHash: "hash_env",
};

/** A plan for Claude Code that delivers what `harness` says, by hand: the
 *  runner carries out whatever plan it is handed. */
function plan(harness: TurnSkills["harness"]): TurnSkills {
  return {
    runtime: { kind: "harness", harnessId: "claude-code" },
    set: buildLiveEffectiveCapabilities({}),
    delivered: [],
    excluded: [],
    serverSkillsVia: "none",
    agent: null,
    ...(harness ? { harness } : {}),
  };
}

describe("harnessTurnSkillsFromPlan", () => {
  it("takes a run's frozen copies with the files that ride with them", async () => {
    const turn = harnessTurnSkillsFromPlan(
      plan({
        mode: "pinned",
        skills: [SKILL],
        files: [{ skillId: "sk_env", path: "scripts/run.sh", content: "echo" }],
        live: false,
      }),
      "claude-code",
    );
    expect(turn.mode).toBe("pinned");
    expect(turn.skills).toEqual([SKILL]);
    expect(turn.skillsHash).toBe(skillsFingerprint([SKILL]));
    const listing = await turn.readFiles();
    expect(listing.files).toEqual([
      { skillId: "sk_env", path: "scripts/run.sh", content: "echo" },
    ]);
    expect(listing.complete("sk_env")).toBe(true);
  });

  it("treats an EMPTY delivery as authoritative, not as absent", async () => {
    // The regression this locks: reading an empty list as "no source" would
    // leave a frozen run's box with the skills an earlier turn wrote, and
    // would hand the without-skills arm those skills.
    const turn = harnessTurnSkillsFromPlan(
      plan({ mode: "pinned", skills: [], files: [], live: false }),
      "claude-code",
    );
    expect(turn.skills).toEqual([]);
    expect(turn.skillsHash).toBe("");
    expect((await turn.readFiles()).complete("anything")).toBe(true);
  });

  it("knows none of an environment's files when the plan could not read them", async () => {
    const turn = harnessTurnSkillsFromPlan(
      plan({ mode: "environment", skills: [SKILL], files: null, live: true }),
      "claude-code",
    );
    expect(turn.skills).toEqual([SKILL]);
    const listing = await turn.readFiles();
    expect(listing.files).toEqual([]);
    // Unknown, so the writer keeps each skill's other files as they are.
    expect(listing.complete("sk_env")).toBe(false);
  });

  it("leaves the box as it is when the turn named no source", async () => {
    for (const turn of [
      harnessTurnSkillsFromPlan(undefined, "claude-code"),
      harnessTurnSkillsFromPlan(
        plan({ mode: "none", skills: null, files: null, live: false }),
        "claude-code",
      ),
      harnessTurnSkillsFromPlan(plan(undefined), "claude-code"),
    ]) {
      expect(turn).toMatchObject({
        mode: "none",
        skills: null,
        skillsHash: undefined,
        live: false,
      });
      expect((await turn.readFiles()).files).toEqual([]);
    }
  });

  it("keeps a live turn live even when it read no skills of its own", () => {
    // A study whose Library could not be read still has its servers.
    const turn = harnessTurnSkillsFromPlan(
      plan({ mode: "none", skills: null, files: null, live: true }),
      "claude-code",
    );
    expect(turn).toMatchObject({ mode: "none", skills: null, live: true });
  });

  it("fails before a box is written when the plan was made for another engine", () => {
    const other = plan({ mode: "pinned", skills: [], files: [], live: false });
    expect(() => harnessTurnSkillsFromPlan(other, "codex")).toThrow(
      "made for claude-code, but codex is running it",
    );
    expect(() =>
      harnessTurnSkillsFromPlan(
        { ...other, runtime: { kind: "agent" }, harness: undefined },
        "codex",
      ),
    ).toThrow("made for MCPJam's agent");
  });
});
