/**
 * What each engine receives on each surface, written down by hand.
 *
 * A row states, for one surface and one engine, the skills the engine is
 * handed, the ones it is not with their reason, how MCP-server skills travel
 * and what the turn records. Each row is checked twice against that
 * hand-written answer: once for the surface's plan (`resolveTurnSkills`), and
 * once for what reaches the engine, read through the code the engine runs:
 * MCPJam's agent's prompt and tools from `prepareChatV2`, a harness's box from
 * the box writer, on a box earlier turns of other runtimes left skills on.
 * Checking the plan against the engine alone would pass if both were wrong the
 * same way.
 */
import { describe, expect, it } from "vitest";
import type { PinnedSkillArtifact } from "@/shared/skill-types";
import { iterationTurnSkills } from "../../evals/pinned-skill-source";
import type {
  ServerSkillsVia,
  SkillExclusionReason,
  TurnSkills,
} from "../turn-skills";
import {
  agentReceives,
  boxReceives,
  preparedRunSkills,
  writeTurnToBox,
} from "../../../test/support/skill-delivery";
import { fakeSkillBox } from "../../../test/support/fake-skill-box";

const ENGINES = [
  "mcpjam-agent",
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "copilot-cli",
] as const;
type Engine = (typeof ENGINES)[number];

interface Expected {
  /** Refs for MCPJam's agent; box folders for a harness. */
  delivered: string[];
  /** `[ref, reason]` for every skill the engine is not handed. */
  excluded: Array<[string, SkillExclusionReason]>;
  serverSkillsVia: ServerSkillsVia;
  /** The `name` of every row the turn records in `skillsAtTurn`. */
  recorded: string[];
}

/** One surface's turn for one engine, planned the way that surface plans it. */
interface PlannedTurn {
  skills: TurnSkills;
  skillsAtTurn?: Array<Record<string, unknown>>;
  /** The copies a harness turn on this surface writes to its box. */
  box: PinnedSkillArtifact[];
}

interface Surface {
  name: string;
  plan(engine: Engine): Promise<PlannedTurn>;
  expected: Record<Engine, Expected>;
}

const RUN_SKILLS = ["release-notes", "summarize", "search"];

const noSkillsOn = (refs: string[]): Expected => ({
  delivered: [],
  excluded: refs.map((ref) => [ref, "unsupported-harness"]),
  serverSkillsVia: "none",
  recorded: [],
});

/** An eval run's iteration, from the run's frozen skills. */
const EVAL: Surface = {
  name: "eval",
  async plan(engine) {
    const run = await preparedRunSkills();
    const { skills, skillsAtTurn } = iterationTurnSkills({
      pinnedSkillSource: run.pinnedSkillSource,
      execution: engine === "mcpjam-agent" ? {} : { harness: engine },
    });
    return {
      skills,
      ...(skillsAtTurn ? { skillsAtTurn } : {}),
      box: run.pinnedHarnessSkills,
    };
  },
  expected: {
    "mcpjam-agent": {
      delivered: ["release-notes", "acme/summarize", "docs/search"],
      excluded: [],
      serverSkillsVia: "agent-tools",
      recorded: RUN_SKILLS,
    },
    // Until server skills reach a harness as tools, a pinned run copies a
    // captured server skill to the box as a plain skill folder.
    "claude-code": {
      delivered: RUN_SKILLS,
      excluded: [],
      serverSkillsVia: "box-files",
      recorded: RUN_SKILLS,
    },
    codex: {
      delivered: RUN_SKILLS,
      excluded: [],
      serverSkillsVia: "box-files",
      recorded: RUN_SKILLS,
    },
    cursor: noSkillsOn(["release-notes", "acme/summarize", "docs/search"]),
    opencode: noSkillsOn(["release-notes", "acme/summarize", "docs/search"]),
    "copilot-cli": noSkillsOn([
      "release-notes",
      "acme/summarize",
      "docs/search",
    ]),
  },
};

/** Each surface joins as one entry here, with its own plan and rows. */
const SURFACES: Surface[] = [EVAL];

const ROWS = SURFACES.flatMap((surface) =>
  ENGINES.map((engine) => ({ surface, engine })),
);

describe.each(ROWS)("$surface.name on $engine", ({ surface, engine }) => {
  const expected = surface.expected[engine];
  const isAgent = engine === "mcpjam-agent";

  it("plans the hand-written delivery", async () => {
    const { skills } = await surface.plan(engine);
    expect(
      skills.delivered.map((ref) => (isAgent ? ref.ref : ref.name)),
    ).toEqual(expected.delivered);
    expect(skills.excluded.map(({ ref, reason }) => [ref.ref, reason])).toEqual(
      expected.excluded,
    );
    expect(skills.serverSkillsVia).toBe(expected.serverSkillsVia);
  });

  it("hands the engine exactly what was written down", async () => {
    const { skills, box } = await surface.plan(engine);
    if (isAgent) {
      const received = await agentReceives(skills);
      expect([...received.listed].sort()).toEqual(
        [...expected.delivered].sort(),
      );
      expect(received.tools).toContain("loadSkill");
    } else {
      // Every folder the runtime reads holds exactly these, whatever earlier
      // turns of other runtimes left on the box.
      expect((await boxReceives(engine, box)).sort()).toEqual(
        [...expected.delivered].sort(),
      );
      // A harness gets its skills on its box, never as agent tools too.
      expect((await agentReceives(skills, { harness: engine })).tools).toEqual(
        [],
      );
    }
  });

  it.skipIf(isAgent)("the box writer reports the delivery it made", async () => {
    const { box } = await surface.plan(engine);
    const written = await writeTurnToBox(
      engine,
      { pinnedHarnessSkills: box },
      fakeSkillBox(),
    );
    expect(written.delivered.map((skill) => skill.name)).toEqual(
      expected.delivered,
    );
    expect(written.notDelivered).toEqual([]);
    expect(written.failed).toEqual([]);
  });

  it("records the skills the engine was handed", async () => {
    const { skillsAtTurn } = await surface.plan(engine);
    expect((skillsAtTurn ?? []).map((row) => row.name)).toEqual(
      expected.recorded,
    );
  });
});
