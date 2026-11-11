import { describe, expect, it } from "vitest";
import { resolveTurnSkills, type TurnSkills } from "../turn-skills";
import type { ResolvedEnvironmentRuntime } from "../runtime";
import {
  agentReceives,
  evalEnvironment,
  personalSkill,
} from "../../../test/support/skill-delivery";

const AGENT = { kind: "agent" } as const;
const harness = (harnessId: string) =>
  ({ kind: "harness", harnessId }) as const;

const refs = (skills: TurnSkills) => skills.delivered.map((ref) => ref.ref);
const names = (skills: TurnSkills) => skills.delivered.map((ref) => ref.name);
const reasons = (skills: TurnSkills) =>
  skills.excluded.map(({ ref, reason }) => [ref.ref, reason]);

/** An environment whose only skill is `docs`. */
function docsEnvironment(): ResolvedEnvironmentRuntime {
  const { spec } = evalEnvironment();
  return {
    ...spec,
    skills: [
      {
        skillId: "sk_docs",
        name: "docs",
        description: "Read the docs.",
        content: "# Docs",
        aggregateHash: "agg-docs",
        channels: ["environment"],
      },
    ],
    serverSkills: [],
    pluginVersions: [],
  };
}

describe("resolveTurnSkills for an environment", () => {
  it("reports a skill the turn's plugin narrowing switched off, on every engine", () => {
    const { spec, attribution } = evalEnvironment();
    const summarize = spec.skills!.find((skill) => skill.name === "summarize")!;
    for (const runtime of [AGENT, harness("claude-code"), harness("cursor")]) {
      const skills = resolveTurnSkills({
        source: {
          kind: "environment",
          spec: {
            ...spec,
            skills: spec.skills!.filter((s) => s !== summarize),
          },
          attribution,
          pluginDisabled: [summarize],
        },
        runtime,
      });
      expect(skills.excluded[0]).toMatchObject({
        ref: { ref: "acme/summarize" },
        reason: "plugin-disabled",
      });
      expect(skills.delivered.map((ref) => ref.skillId)).not.toContain(
        summarize.skillId,
      );
    }
  });

  it("keeps the environment's skill when a client's own one wants its name", () => {
    const pool = [
      {
        ...personalSkill(),
        skillId: "sk_other_docs",
        name: "docs",
        ref: "docs",
      },
    ];
    const source = {
      kind: "environment",
      spec: docsEnvironment(),
      attribution: null,
      liveExtras: { projectSkills: pool },
    } as const;
    for (const runtime of [AGENT, harness("claude-code")]) {
      const skills = resolveTurnSkills({ source, runtime });
      expect(skills.delivered.map((ref) => ref.skillId)).toEqual(["sk_docs"]);
      expect(reasons(skills)).toEqual([["docs", "name-collision"]]);
    }
  });

  it("does not count a client's own skill twice when its environment carries it", () => {
    const pool = [
      { ...personalSkill(), skillId: "sk_docs", name: "docs", ref: "docs" },
    ];
    const skills = resolveTurnSkills({
      source: {
        kind: "environment",
        spec: docsEnvironment(),
        attribution: null,
        liveExtras: { projectSkills: pool },
      },
      runtime: harness("codex"),
    });
    expect(names(skills)).toEqual(["docs"]);
    expect(skills.excluded).toEqual([]);
  });

  it("names a skill a harness's adapter refuses", () => {
    const spec = docsEnvironment();
    const skills = resolveTurnSkills({
      source: {
        kind: "environment",
        spec: {
          ...spec,
          skills: [
            ...spec.skills!,
            { ...spec.skills![0]!, skillId: "sk_bad", name: "Deploy_Tool" },
          ],
        },
        attribution: null,
      },
      runtime: harness("codex"),
    });
    expect(names(skills)).toEqual(["docs"]);
    expect(reasons(skills)).toEqual([["Deploy_Tool", "invalid-skill-name"]]);
  });

  it("takes nothing live into an eval run's plan", async () => {
    const { spec, attribution } = evalEnvironment();
    const skills = resolveTurnSkills({
      source: {
        kind: "environment",
        spec,
        attribution,
        frozen: true,
        liveExtras: { projectSkills: [personalSkill()] },
      },
      runtime: AGENT,
    });
    expect(skills.agent).toEqual({ kind: "frozen" });
    expect(refs(skills)).toEqual([
      "release-notes",
      "acme/summarize",
      "docs/search",
    ]);
    expect(skills.excluded).toEqual([]);
    expect((await agentReceives(skills)).listed.sort()).toEqual([
      "acme/summarize",
      "docs/search",
      "release-notes",
    ]);
  });

  it("tells a named environment's turn from a client's", () => {
    const { spec, attribution } = evalEnvironment();
    const named = resolveTurnSkills({
      source: { kind: "environment", spec, attribution },
      runtime: AGENT,
    });
    const client = resolveTurnSkills({
      source: {
        kind: "environment",
        spec,
        attribution,
        liveExtras: { projectSkills: [] },
      },
      runtime: AGENT,
    });
    // A client's servers are connected now, so their own skills join when its
    // prompt is built; a named environment's were captured with it.
    expect(named.agent).toEqual({ kind: "environment" });
    expect(client.agent).toEqual({ kind: "live" });
  });
});

describe("resolveTurnSkills for a client with no environment", () => {
  it("plans the client's own skills alone, on either engine", async () => {
    const source = {
      kind: "live",
      liveExtras: { projectSkills: [personalSkill()] },
    } as const;
    const agent = resolveTurnSkills({ source, runtime: AGENT });
    expect(agent.agent).toEqual({ kind: "live" });
    expect(refs(agent)).toEqual(["my-notes"]);
    expect((await agentReceives(agent)).listed).toEqual(["my-notes"]);
    const box = resolveTurnSkills({ source, runtime: harness("claude-code") });
    expect(names(box)).toEqual(["my-notes"]);
    expect(box.serverSkillsVia).toBe("none");
  });
});
