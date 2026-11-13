/**
 * What each engine receives on each surface, written down by hand.
 *
 * A row states, for one surface and one engine, the skills the engine is
 * handed, the ones it is not with their reason, how MCP-server skills travel
 * and what the turn records. Each row is checked twice against that
 * hand-written answer: once for the surface's plan (`resolveTurnSkills`), and
 * once for what reaches the engine, read through the code the engine runs:
 * MCPJam's agent's prompt and tools from `prepareChatV2`, a harness's box from
 * the box writer, on a box earlier turns of other runtimes left skills on, and
 * the MCP-server skills its turn serves through MCPJam's skill tools.
 * Checking the plan against the engine alone would pass if both were wrong the
 * same way.
 *
 * A preview plans a turn it does not run, so its engine check reads the turn
 * it previews: the eval run for the Evaluate page, a live turn for Compare.
 */
import { describe, expect, it, vi } from "vitest";
import { readScenarioEnvironment } from "../../../utils/scenario-runtime-config";
import { readScenarioServerSkills } from "../../../utils/scenario-server-skills";
import { iterationTurnSkills } from "../../evals/pinned-skill-source";
import { replayRunSkills } from "../../evals/replay-suite-run";
import { sessionTurnSkills } from "../../sessionSimulation/session-skills";
import { resolveEffectiveCapabilities } from "../effective-capabilities";
import {
  environmentTurnSkills,
  studyLibraryTurnSkills,
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
  EVAL_PLUGIN_VERSIONS,
  evalEnvironment,
  evalRunPins,
  harnessToolsServe,
  liveTurnSource,
  preparedRunSkills,
  preparedTargetSkills,
  visibleScopeEnvironment,
} from "../../../test/support/skill-delivery";

// An older study's turn reads its shared Library through the study's scope:
// here, the fixture's authored skill and its supporting file.
vi.mock("../../../utils/harness/runtime-skills", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/runtime-skills")
  >()),
  fetchRuntimeSkills: async () => ({
    ok: true,
    skills: [
      {
        skillId: "sk_release_notes",
        name: "release-notes",
        description: "Write release notes from merged changes.",
        content: "# Release notes\n\nRun scripts/check.sh first.",
        aggregateHash: "agg-release-notes",
      },
    ],
  }),
  fetchRuntimeSkillFiles: async () => ({
    ok: true,
    files: [
      {
        skillId: "sk_release_notes",
        path: "scripts/check.sh",
        size: 23,
        url: `data:text/x-shellscript;base64,${Buffer.from("#!/bin/sh\necho checked\n").toString("base64")}`,
      },
    ],
  }),
}));

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
  /** Refs for MCPJam's agent; skill names for a harness. */
  delivered: string[];
  /** A harness's box folders, when they differ from `delivered`. */
  box?: string[];
  /** Refs a harness's turn serves through MCPJam's skill tools. */
  viaTools?: string[];
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
  box: Awaited<ReturnType<typeof harnessBox>>;
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
  // A captured server skill reaches the runtime through MCPJam's skill
  // tools, and nothing from a server is on the box.
  "claude-code": {
    delivered: RUN_SKILLS,
    box: ["release-notes", "summarize"],
    viaTools: ["docs/search"],
    excluded: [],
    serverSkillsVia: "harness-tools",
    recorded: RUN_SKILLS,
  },
  codex: {
    delivered: RUN_SKILLS,
    box: ["release-notes", "summarize"],
    viaTools: ["docs/search"],
    excluded: [],
    serverSkillsVia: "harness-tools",
    recorded: RUN_SKILLS,
  },
  opencode: {
    delivered: RUN_SKILLS,
    excluded: [],
    serverSkillsVia: "box-files",
    recorded: RUN_SKILLS,
  },
  cursor: {
    delivered: RUN_SKILLS,
    excluded: [],
    serverSkillsVia: "box-files",
    recorded: RUN_SKILLS,
  },
  "copilot-cli": {
    delivered: RUN_SKILLS,
    excluded: [],
    serverSkillsVia: "box-files",
    recorded: RUN_SKILLS,
  },
};

const runOn = (engine: Engine) =>
  engine === "mcpjam-agent" ? {} : { harness: engine };

const runtimeOf = (engine: Engine): TurnRuntime =>
  engine === "mcpjam-agent"
    ? { kind: "agent" }
    : { kind: "harness", harnessId: engine };

/** The box of a harness turn and the server skills its tools serve; MCPJam's
 *  agent has none. `environment` is the set an environment turn carries. */
const harnessBox = async (
  engine: Engine,
  source: Parameters<typeof boxReceives>[1],
  environment?: Parameters<typeof harnessToolsServe>[2],
) =>
  engine === "mcpjam-agent"
    ? null
    : {
        ...(await boxReceives(engine, source)),
        viaTools: await harnessToolsServe(engine, source, environment),
      };

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
      execution: runOn(engine),
    });
    return {
      skills,
      ...(skillsAtTurn ? { skillsAtTurn } : {}),
      box: await harnessBox(engine, {
        pinnedHarnessSkills: run.pinnedHarnessSkills,
      }),
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
      box: await harnessBox(engine, {
        pinnedHarnessSkills: run.pinnedHarnessSkills,
      }),
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
      box: await harnessBox(engine, {
        pinnedHarnessSkills: [...target.harnessSkills],
      }),
    };
  };

const SWARM: Surface = { name: "swarm", plan: swarm(false), expected: PINNED };

/** With approval on, every engine gets what it gets without: no skill tool
 *  asks, so a headless visitor has nothing to answer. */
const SWARM_APPROVAL: Surface = {
  name: "swarm with approval on",
  plan: swarm(true),
  expected: PINNED,
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
  const names = ["release-notes", "summarize", ...extra, "search"];
  // The environment's captured server skill reaches the runtime through
  // MCPJam's skill tools, and nothing from a server is on the box.
  const harness: Expected = {
    delivered: names,
    box: ["release-notes", "summarize", ...extra],
    viaTools: ["docs/search"],
    excluded: [],
    serverSkillsVia: "harness-tools",
    recorded: recorded ? names : [],
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
    cursor: {
      delivered: ["release-notes", "summarize", ...extra],
      excluded: [["docs/search", "server-skill-unsupported"]],
      serverSkillsVia: "none",
      recorded: recorded ? ["release-notes", "summarize", ...extra] : [],
    },
    opencode: {
      delivered: ["release-notes", "summarize", ...extra],
      excluded: [["docs/search", "server-skill-unsupported"]],
      serverSkillsVia: "none",
      recorded: recorded ? ["release-notes", "summarize", ...extra] : [],
    },
    "copilot-cli": {
      delivered: ["release-notes", "summarize", ...extra],
      excluded: [["docs/search", "server-skill-unsupported"]],
      serverSkillsVia: "none",
      recorded: recorded ? ["release-notes", "summarize", ...extra] : [],
    },
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
      box: await harnessBox(
        engine,
        liveTurnSource(spec),
        resolveEffectiveCapabilities(spec, attribution),
      ),
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
      box: await harnessBox(
        engine,
        liveTurnSource(spec),
        resolveEffectiveCapabilities(spec, attribution),
      ),
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
            ...(turn.box.set ? { effectiveCapabilities: turn.box.set } : {}),
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

/** A User Testing session in an environment-backed study, read off the
 *  study's runtime config as a guest tester's turn reads it. */
const STUDY_TURN: Surface = {
  name: "user testing, environment-backed study",
  async plan(engine) {
    const { spec, attribution } = evalEnvironment();
    const config = { environment: spec };
    const read = readScenarioEnvironment(config as never);
    if (read.kind !== "present") throw new Error("no study environment");
    return plannedLiveTurn(
      engine,
      environmentTurnSkills({
        spec: {
          ...read.environment,
          serverSkills: readScenarioServerSkills(config),
        },
        attribution,
        runtime: runtimeOf(engine),
      }),
    );
  },
  expected: liveRows([], true),
};

/** A User Testing session in a study that predates environments: the study's
 *  shared Library, read through the study's scope. It names no environment,
 *  so it records nothing. */
const OLDER_STUDY_TURN: Surface = {
  name: "user testing, older study",
  async plan(engine) {
    return plannedLiveTurn(
      engine,
      await studyLibraryTurnSkills({
        bearer: "Bearer tester",
        projectId: "project_1",
        runtime: runtimeOf(engine),
      }),
    );
  },
  expected: {
    "mcpjam-agent": {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "agent-tools",
      recorded: [],
    },
    // The session stays live on its servers, and a runtime that takes server
    // skills through MCPJam's tools offers the connected servers' own there,
    // though the study names no environment.
    "claude-code": {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "harness-tools",
      recorded: [],
    },
    codex: {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "harness-tools",
      recorded: [],
    },
    cursor: {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "none",
      recorded: [],
    },
    opencode: {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "none",
      recorded: [],
    },
  "copilot-cli": {
      delivered: ["release-notes"],
      excluded: [],
      serverSkillsVia: "none",
      recorded: [],
    },
  },
};

/** Each surface joins as one entry here, with its own plan and rows. */
const SURFACES: Surface[] = [
  EVAL,
  REPLAY,
  SWARM,
  SWARM_APPROVAL,
  EVALUATE_PREVIEW,
  COMPARE_ENVIRONMENT_PREVIEW,
  COMPARE_CLIENT_PREVIEW,
  clientTurn("playground, client turn"),
  namedEnvironmentTurn("playground, named environment"),
  clientTurn("chat over the API, client turn"),
  namedEnvironmentTurn("chat over the API, named environment"),
  STUDY_TURN,
  OLDER_STUDY_TURN,
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
      // Skill tools come with skills to load, and never without.
      expect(received.tools.includes("loadSkill")).toBe(
        expected.delivered.length > 0,
      );
    } else {
      // Every folder the runtime reads holds exactly these, whatever earlier
      // turns of other runtimes left on the box: nothing from a server.
      expect([...box!.folders].sort()).toEqual(
        [...(expected.box ?? expected.delivered)].sort(),
      );
      expect(box!.viaTools).toEqual(expected.viaTools ?? []);
      // A harness gets its skills on its box and its tools, never as MCPJam's
      // agent's tools too.
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
        expected.box ?? expected.delivered,
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
