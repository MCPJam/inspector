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
 *
 * A preview plans a turn it does not run, so its engine check reads the turn
 * it previews: the eval run for the Evaluate page, a live turn for Compare.
 */
import { describe, expect, it } from "vitest";
import { iterationTurnSkills } from "../../evals/pinned-skill-source";
import {
  environmentTurnSkills,
  type LiveTurnSkills,
} from "../live-turn-skills";
import {
  resolveTurnSkills,
  type ServerSkillsVia,
  type SkillExclusionReason,
  type TurnRuntime,
  type TurnSkills,
} from "../turn-skills";
import {
  agentReceives,
  boxReceives,
  evalEnvironment,
  liveTurnSource,
  preparedRunSkills,
  visibleScopeEnvironment,
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
  /** A harness turn's box on this surface; MCPJam's agent has none. */
  box: Awaited<ReturnType<typeof boxReceives>> | null;
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

const runtimeOf = (engine: Engine): TurnRuntime =>
  engine === "mcpjam-agent"
    ? { kind: "agent" }
    : { kind: "harness", harnessId: engine };

/** The box of a harness turn; MCPJam's agent has none. */
const harnessBox = (
  engine: Engine,
  source: Parameters<typeof boxReceives>[1],
) => (engine === "mcpjam-agent" ? null : boxReceives(engine, source));

/** A preview records nothing: it plans a turn it does not run. */
function previewing(rows: Record<Engine, Expected>): Record<Engine, Expected> {
  const preview = { ...rows };
  for (const engine of ENGINES)
    preview[engine] = { ...rows[engine], recorded: [] };
  return preview;
}

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
      box: await harnessBox(engine, {
        pinnedHarnessSkills: run.pinnedHarnessSkills,
      }),
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

/**
 * The Evaluate page's preview of the eval fixture's environment, which an
 * eval run freezes into the eval surface's pins: the same rows as that run.
 */
const EVALUATE_PREVIEW: Surface = {
  name: "evaluate preview",
  async plan(engine) {
    const { spec, attribution } = evalEnvironment();
    const run = await preparedRunSkills();
    return {
      skills: resolveTurnSkills({
        source: { kind: "environment", spec, attribution, frozen: true },
        runtime: runtimeOf(engine),
      }),
      box: await harnessBox(engine, {
        pinnedHarnessSkills: run.pinnedHarnessSkills,
      }),
    };
  },
  expected: previewing(EVAL.expected),
};

/**
 * A live turn on the fixture environment, and the same with a client's own
 * skill beside it, which the backend's visible scope adds to the client's
 * hidden environment. `recorded` is false for a preview, which runs no turn.
 */
const liveRows = (
  extra: string[],
  recorded: boolean,
): Record<Engine, Expected> => {
  // The scope's skills are the environment's own, ahead of its captures.
  const refs = ["release-notes", "acme/summarize", ...extra, "docs/search"];
  // Until server skills reach a harness as tools, a live harness turn
  // leaves a captured server skill off its box.
  const boxed = ["release-notes", "summarize", ...extra];
  const harness: Expected = {
    delivered: boxed,
    excluded: [["docs/search", "server-skill-unsupported"]],
    serverSkillsVia: "none",
    recorded: recorded ? boxed : [],
  };
  return {
    "mcpjam-agent": {
      delivered: refs,
      excluded: [],
      serverSkillsVia: "agent-tools",
      recorded: recorded
        ? ["release-notes", "summarize", ...extra, "search"]
        : [],
    },
    "claude-code": harness,
    codex: harness,
    cursor: noSkillsOn(refs),
    opencode: noSkillsOn(refs),
    "copilot-cli": noSkillsOn(refs),
  };
};

/** The Compare pane's preview of a named environment's next turn. */
const COMPARE_ENVIRONMENT_PREVIEW: Surface = {
  name: "compare preview, named environment",
  async plan(engine) {
    const { spec, attribution } = evalEnvironment();
    return {
      skills: resolveTurnSkills({
        source: { kind: "environment", spec, attribution },
        runtime: runtimeOf(engine),
      }),
      box: await harnessBox(engine, liveTurnSource(spec)),
    };
  },
  expected: liveRows([], false),
};

/** The Compare pane's preview of a client turn: its hidden environment,
 *  resolved in the client's all-visible selection. */
const COMPARE_CLIENT_PREVIEW: Surface = {
  name: "compare preview, client with its own skills",
  async plan(engine) {
    const { spec, attribution } = visibleScopeEnvironment();
    return {
      skills: resolveTurnSkills({
        source: { kind: "environment", spec, attribution, liveExtras: {} },
        runtime: runtimeOf(engine),
      }),
      box: await harnessBox(engine, liveTurnSource(spec)),
    };
  },
  expected: liveRows(["my-notes"], false),
};

/** A live surface's turn, planned by the module the surface calls, with the
 *  box it hands the harness and the record it writes. */
async function plannedLiveTurn(
  engine: Engine,
  turn: LiveTurnSkills,
): Promise<PlannedTurn> {
  return {
    skills: turn.skills,
    ...(turn.turnProvenance
      ? { skillsAtTurn: turn.turnProvenance.skillsAtTurn }
      : {}),
    box: await harnessBox(engine, {
      ...(turn.box
        ? {
            runtimeSkillsOverride: turn.box.skills,
            effectiveCapabilities: turn.box.set,
          }
        : {}),
    }),
  };
}

/** A client's turn on the Playground or over the API: its hidden
 *  environment, resolved in the client's all-visible selection. */
const clientTurn = (name: string): Surface => ({
  name,
  async plan(engine) {
    const { spec, attribution } = visibleScopeEnvironment();
    return plannedLiveTurn(
      engine,
      environmentTurnSkills({
        spec,
        attribution,
        liveExtras: {},
        runtime: runtimeOf(engine),
      }),
    );
  },
  expected: liveRows(["my-notes"], true),
});

/** A turn on a named environment, on the Playground or over the API. */
const namedEnvironmentTurn = (name: string): Surface => ({
  name,
  async plan(engine) {
    const { spec, attribution } = evalEnvironment();
    return plannedLiveTurn(
      engine,
      environmentTurnSkills({ spec, attribution, runtime: runtimeOf(engine) }),
    );
  },
  expected: liveRows([], true),
});

/** Each surface joins as one entry here, with its own plan and rows. */
const SURFACES: Surface[] = [
  EVAL,
  EVALUATE_PREVIEW,
  COMPARE_ENVIRONMENT_PREVIEW,
  COMPARE_CLIENT_PREVIEW,
  clientTurn("playground, client turn"),
  namedEnvironmentTurn("playground, named environment"),
  clientTurn("chat over the API, client turn"),
  namedEnvironmentTurn("chat over the API, named environment"),
];

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
      expect([...box!.folders].sort()).toEqual([...expected.delivered].sort());
      // A harness gets its skills on its box, never as agent tools too.
      expect((await agentReceives(skills, { harness: engine })).tools).toEqual(
        [],
      );
    }
  });

  it.skipIf(isAgent)(
    "the box writer reports the delivery it made",
    async () => {
      const { written } = (await surface.plan(engine)).box!;
      expect(written.delivered.map((skill) => skill.name)).toEqual(
        expected.delivered,
      );
      expect(written.notDelivered).toEqual([]);
      expect(written.failed).toEqual([]);
    },
  );

  it("records the skills the engine was handed", async () => {
    const { skillsAtTurn } = await surface.plan(engine);
    expect((skillsAtTurn ?? []).map((row) => row.name)).toEqual(
      expected.recorded,
    );
  });
});
