/**
 * What each engine receives on each surface, written down by hand.
 *
 * A row states, for one surface and one engine, the skills the engine is
 * handed, the ones it is not with their reason, how MCP-server skills travel
 * and what the turn records. Each row is checked twice against that
 * hand-written answer: once for the surface's plan (`resolveTurnSkills`), and
 * once for what reaches the engine, read through the code the engine runs:
 * MCPJam's agent's prompt and tools from `prepareChatV2`, a harness's box from
 * its pinned skill path. Checking the plan against the engine alone would pass
 * if both were wrong the same way.
 */
import { describe, expect, it } from "vitest";
import type { PinnedSkillArtifact } from "@/shared/skill-types";
import { iterationTurnSkills } from "../../evals/pinned-skill-source";
import { replayRunSkills } from "../../evals/replay-suite-run";
import { sessionTurnSkills } from "../../sessionSimulation/session-skills";
import type {
  ServerSkillsVia,
  SkillExclusionReason,
  TurnSkills,
} from "../turn-skills";
import {
  agentReceives,
  boxReceives,
  EVAL_PLUGIN_VERSIONS,
  evalRunPins,
  preparedRunSkills,
  preparedTargetSkills,
} from "../../../test/support/skill-delivery";

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

/**
 * What each engine receives of the fixture's three skills wherever they were
 * pinned: an eval run, its replay and a swarm target all deliver the same.
 */
const PINNED: Record<Engine, Expected> = {
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
  "copilot-cli": noSkillsOn(["release-notes", "acme/summarize", "docs/search"]),
};

const runOn = (engine: Engine) =>
  engine === "mcpjam-agent" ? {} : { harness: engine };

/** An eval run's iteration, from the run's frozen skills. */
const EVAL: Surface = {
  name: "eval",
  async plan(engine) {
    const run = await preparedRunSkills();
    const { skills, skillsAtTurn } = iterationTurnSkills({
      pinnedSkillSource: run.pinnedSkillSource,
      execution: runOn(engine),
    });
    return {
      skills,
      ...(skillsAtTurn ? { skillsAtTurn } : {}),
      box: run.pinnedHarnessSkills,
    };
  },
  expected: PINNED,
};

/** A replay's iteration: the backend copies the eval run's pins onto the
 *  replay run, which reads them back as its own. */
const REPLAY: Surface = {
  name: "replay",
  async plan(engine) {
    const run = await replayRunSkills({
      convexClient: { query: async () => ({ pinnedSkills: evalRunPins() }) },
      runId: "replay-run",
      pluginVersions: EVAL_PLUGIN_VERSIONS,
      serverIds: ["srv_docs"],
    });
    const { skills, skillsAtTurn } = iterationTurnSkills({
      pinnedSkillSource: run.pinnedSkillSource,
      execution: runOn(engine),
    });
    return {
      skills,
      ...(skillsAtTurn ? { skillsAtTurn } : {}),
      box: run.pinnedHarnessSkills,
    };
  },
  expected: PINNED,
};

/** A swarm session's turn, from its target's frozen skills. */
const swarm =
  (requireToolApproval: boolean): Surface["plan"] =>
  async (engine) => {
    const target = await preparedTargetSkills();
    const { skills, skillsAtTurn } = sessionTurnSkills({
      pinnedSkillSource: target,
      ...runOn(engine),
      requireToolApproval,
    });
    return {
      skills,
      ...(skillsAtTurn ? { skillsAtTurn } : {}),
      box: [...target.harnessSkills],
    };
  };

const SWARM: Surface = { name: "swarm", plan: swarm(false), expected: PINNED };

/** With approval on, MCPJam's agent gets none of the target's skills, since a
 *  headless visitor can't approve; a harness's box still gets them. */
const SWARM_APPROVAL: Surface = {
  name: "swarm with approval on",
  plan: swarm(true),
  expected: {
    ...PINNED,
    "mcpjam-agent": {
      delivered: [],
      excluded: [],
      serverSkillsVia: "none",
      recorded: [],
    },
  },
};

/** Each surface joins as one entry here, with its own plan and rows. */
const SURFACES: Surface[] = [EVAL, REPLAY, SWARM, SWARM_APPROVAL];

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
      // Skill tools come with skills to load, and never without.
      expect(received.tools.includes("loadSkill")).toBe(
        expected.delivered.length > 0,
      );
    } else {
      expect(boxReceives(engine, box).sort()).toEqual(
        [...expected.delivered].sort(),
      );
      // A harness gets its skills on its box, never as agent tools too.
      expect((await agentReceives(skills, { harness: engine })).tools).toEqual(
        [],
      );
    }
  });

  it("records the skills the engine was handed", async () => {
    const { skillsAtTurn } = await surface.plan(engine);
    expect((skillsAtTurn ?? []).map((row) => row.name)).toEqual(
      expected.recorded,
    );
  });
});
