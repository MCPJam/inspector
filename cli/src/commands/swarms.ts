/**
 * `mcpjam cloud personas` / `mcpjam cloud swarms` / the authoring and insight halves of
 * `mcpjam cloud goals` — the rest of the Swarms product on the command line.
 *
 * `commands/goals.ts` already covers the run loop (list, run, status,
 * sessions, cancel). What it could not do is AUTHOR anything: a goal needs a
 * persona, and there was no way to make one outside the app. These commands
 * close that, and add the insight reads that turn a finished run into an
 * answer.
 *
 * They live here rather than in `goals.ts` because that file is about the
 * run loop and is already 340 lines of it; splitting on "run it" versus "make
 * it and read what it meant" keeps both readable. The `goals` group itself
 * is extended in place — a user should not have to learn that `goals run`
 * and `goals create` come from different files.
 *
 * BETA. Authoring is behind a per-organization flag. The commands exist
 * regardless and the server says plainly when the flag is off for yours: a
 * command that answers "not currently available for your organization" is a
 * better answer than a command that does not exist. `mcpjam cloud projects capabilities` asks
 * the question directly.
 */
import type { Command } from "commander";
import { goalIdOf } from "./goals.js";
import { usageError } from "../lib/output.js";
import {
  archiveGoalOperation,
  archiveSwarmOperation,
  cancelSwarmRunInsightsOperation,
  createGoalOperation,
  createPersonaOperation,
  createSwarmOperation,
  deletePersonaOperation,
  dismissSwarmFindingOperation,
  generateGoalsOperation,
  generatePersonasOperation,
  getGoalOperation,
  getGoalRunScorecardOperation,
  getPersonaOperation,
  getSwarmOperation,
  getSwarmOverviewOperation,
  getSwarmRunInsightsOperation,
  listPersonasOperation,
  listSwarmFindingsOperation,
  listSwarmsOperation,
  requestSwarmRunInsightsOperation,
  undismissSwarmFindingOperation,
  updateGoalOperation,
  updatePersonaOperation,
  updateSwarmOperation,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  requireExactlyOne,
  requireTogether,
  type PlatformOptions,
} from "../lib/platform-command.js";

/** Bounds mirrored from the operation schemas, so a typo fails locally. */
const SESSIONS_BOUNDS = { min: 1, max: 100 };
const TURNS_BOUNDS = { min: 1, max: 200 };
const JOURNEY_COUNT_BOUNDS = { min: 1, max: 5 };
const PERSONA_COUNT_BOUNDS = { min: 1, max: 12 };

/**
 * The grounding half of a generation request, validated and normalized.
 *
 * Shared because both generate commands have the same exactly-one rule and the
 * same optional count, and duplicating it is how the two would drift.
 */
type GroundingOptions = {
  environment?: string;
  serverAttachment?: string;
  description?: string;
  journeyCount?: string;
};

function baseGroundingArgs(options: GroundingOptions) {
  requireExactlyOne({
    "--environment": options.environment,
    "--server-attachment": options.serverAttachment,
  });
  return {
    ...(options.environment ? { environmentId: options.environment } : {}),
    ...(options.serverAttachment
      ? { serverAttachmentId: options.serverAttachment }
      : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}

/**
 * Grounding for `personas generate`, whose draft-count field is still spelled
 * `journeyCount`: it is declared on the grounding input both generate
 * operations share, so the goal rename did not move it.
 */
function groundingArgs(options: GroundingOptions) {
  const journeyCount = parseIntegerOption(
    options.journeyCount,
    "--journey-count",
    JOURNEY_COUNT_BOUNDS
  );
  return {
    ...baseGroundingArgs(options),
    ...(journeyCount !== undefined ? { journeyCount } : {}),
  };
}

/**
 * Grounding for `goals generate`, which takes `goalCount` and keeps
 * `--journey-count` as the pre-rename spelling. Passing both is refused rather
 * than resolved by precedence, the same rule the operation enforces.
 */
function goalGroundingArgs(options: GroundingOptions & { goalCount?: string }) {
  if (options.goalCount !== undefined && options.journeyCount !== undefined) {
    throw usageError(
      "Use either --goal-count or its deprecated --journey-count alias, not both."
    );
  }
  const goalCount = parseIntegerOption(
    options.goalCount ?? options.journeyCount,
    "--goal-count",
    JOURNEY_COUNT_BOUNDS
  );
  return {
    ...baseGroundingArgs(options),
    ...(goalCount !== undefined ? { goalCount } : {}),
  };
}

type ProjectOptions = PlatformOptions & { project?: string };

/**
 * The two execution knobs, on the commands that take them.
 *
 * `--iterations` is the one worth reading twice: total sessions is
 * targets x this, and the total is what spends. Four environments at 10
 * iterations each is 40 conversations, not 10.
 *
 * `--sessions-per-target` is the pre-rename spelling of the same flag, kept so
 * existing scripts keep running. Passing both is refused rather than resolved
 * by precedence — they configure spend.
 */
function addConfigOptions(command: Command, required: boolean): Command {
  const iterations = "--iterations <n>";
  const legacyIterations = "--sessions-per-target <n>";
  const turns = "--max-turns <n>";
  const iterationsHelp =
    "Sessions run against EACH target. Total sessions = targets x this, and the total is what spends.";
  const legacyHelp = "Deprecated alias for --iterations.";
  const turnsHelp = "Cap on assistant turns per session.";
  const withIterations = command
    .option(iterations, iterationsHelp)
    .option(legacyIterations, legacyHelp);
  return required
    ? withIterations.requiredOption(turns, turnsHelp)
    : withIterations.option(turns, turnsHelp);
}

type IterationOptions = { iterations?: string; sessionsPerTarget?: string };

/**
 * The per-target session count, from whichever spelling was given.
 *
 * Commander cannot express "exactly one of these two", so both flags are
 * optional there and the rule lives here. Passing both is refused rather than
 * resolved by precedence: this number multiplies into spend.
 */
function iterationsOf(options: IterationOptions): number | undefined {
  if (
    options.iterations !== undefined &&
    options.sessionsPerTarget !== undefined
  ) {
    throw usageError(
      "Use either --iterations or its deprecated --sessions-per-target alias, not both."
    );
  }
  const raw = options.iterations ?? options.sessionsPerTarget;
  return raw === undefined
    ? undefined
    : parseIntegerOption(raw, "--iterations", SESSIONS_BOUNDS);
}

/**
 * The swarm run id, from whichever spelling was given.
 *
 * `--swarm-run` is the public name; `--wave` is the pre-rename spelling, kept
 * so existing scripts keep running. Passing both is refused rather than
 * resolved by precedence.
 */
function swarmRunIdOf(options: { swarmRun?: string; wave?: string }): string {
  if (options.swarmRun !== undefined && options.wave !== undefined) {
    throw usageError(
      "Use either --swarm-run or its deprecated --wave alias, not both."
    );
  }
  const selected = options.swarmRun ?? options.wave;
  if (selected === undefined) {
    throw usageError("Missing required option: --swarm-run");
  }
  return selected;
}

/** The same, on a command that requires it. */
function requiredIterationsOf(options: IterationOptions): number {
  const value = iterationsOf(options);
  if (value === undefined) {
    throw usageError("Missing required option: --iterations");
  }
  return value;
}

function addGroundingOptions(command: Command): Command {
  return command
    .option(
      "--environment <id>",
      "Ground the drafts in this project environment. Use this one normally."
    )
    .option(
      "--server-attachment <id>",
      "Legacy grounding source. Prefer --environment."
    )
    .option("--description <text>", "Who the audience is, in your own words.")
    .option("--journey-count <n>", "How many goals to draft per persona.");
}

/**
 * The draft-count flag on `goals generate`, where the field was renamed.
 * `--journey-count` comes from {@link addGroundingOptions} and stays as the
 * deprecated alias.
 */
function addGoalCountOption(command: Command): Command {
  return command.option("--goal-count <n>", "How many goals to draft.");
}

export function registerSwarmAuthoringCommands(
  program: Command,
  goals: Command
): void {
  // ── personas ────────────────────────────────────────────────────────────
  const personas = program
    .command("personas")
    .description(
      "The reusable synthetic characters Swarms goals run as. A persona carries a name, a role and behavioural notes; the task lives on each goal."
    );

  bindOperation(
    addProjectOption(
      personas.command("list").description("List the project's personas.")
    ),
    listPersonasOperation,
    (options: ProjectOptions) => ({ project: options.project })
  );

  bindOperation(
    addProjectOption(
      personas
        .command("get")
        .description("Show one persona in full, including its notes.")
        .requiredOption("--persona <id>", "Persona ID")
    ),
    getPersonaOperation,
    (options: ProjectOptions & { persona: string }) => ({
      project: options.project,
      persona: options.persona,
    })
  );

  bindOperation(
    addProjectOption(
      personas
        .command("create")
        .description(
          "Create a persona. Pass --idempotency-key when scripting: the server replays it BEFORE uniquifying the slug, so a retry without one leaves a second near-identical persona rather than the one you already made."
        )
        .requiredOption("--name <name>", "Display name")
        .requiredOption(
          "--role <role>",
          "Who they are, in a few words — 'enterprise procurement lead'"
        )
        .option(
          "--notes <text>",
          "How they behave: what they know, what they will not tolerate, how they phrase things"
        )
        .option("--idempotency-key <key>", "Retry key")
    ),
    createPersonaOperation,
    (
      options: ProjectOptions & {
        name: string;
        role: string;
        notes?: string;
        idempotencyKey?: string;
      }
    ) => ({
      project: options.project,
      name: options.name,
      role: options.role,
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    })
  );

  bindOperation(
    addProjectOption(
      personas
        .command("update")
        .description(
          "Edit a persona. Finished runs keep the persona they ran as — editing does not rewrite history."
        )
        .requiredOption("--persona <id>", "Persona ID")
        .option("--name <name>")
        .option("--role <role>")
        .option("--notes <text>")
    ),
    updatePersonaOperation,
    (
      options: ProjectOptions & {
        persona: string;
        name?: string;
        role?: string;
        notes?: string;
      }
    ) => ({
      project: options.project,
      persona: options.persona,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
    })
  );

  bindOperation(
    addProjectOption(
      personas
        .command("delete")
        .description(
          "Take a persona off the roster. SOFT: finished runs and sessions keep resolving it, so history stays readable, but it cannot be used for new goals and a second delete answers not-found."
        )
        .requiredOption("--persona <id>", "Persona ID")
    ),
    deletePersonaOperation,
    (options: ProjectOptions & { persona: string }) => ({
      project: options.project,
      persona: options.persona,
    })
  );

  bindOperation(
    addGroundingOptions(
      addProjectOption(
        personas
          .command("generate")
          .description(
            "Draft candidate personas with a model, grounded in what the project's servers do. SAVES NOTHING — pipe what you want into `personas create`. Included with MCPJam; no customer credits consumed; counts against the organization's daily generation quota."
          )
          .option("--persona-count <n>", "Draft a slate of N personas.")
      )
    ),
    generatePersonasOperation,
    (
      options: ProjectOptions & {
        environment?: string;
        serverAttachment?: string;
        description?: string;
        journeyCount?: string;
        personaCount?: string;
      }
    ) => {
      const personaCount = parseIntegerOption(
        options.personaCount,
        "--persona-count",
        PERSONA_COUNT_BOUNDS
      );
      return {
        project: options.project,
        ...groundingArgs(options),
        ...(personaCount !== undefined ? { personaCount } : {}),
      };
    }
  );

  // ── goals: authoring + insights, added to the existing group ─────────────

  bindOperation(
    addProjectOption(
      goals
        .command("get")
        .description(
          "Show one goal in full. Read this before launching if you want to know what a run will cost: it produces targets x iterations conversations."
        )
        .option("--goal-id <id>", "Goal ID")
        .option("--journey <id>", "Deprecated alias for --goal-id")
    ),
    getGoalOperation,
    (options: ProjectOptions & { goalId?: string; journey?: string }) => ({
      project: options.project,
      goalId: goalIdOf(options),
    })
  );

  bindOperation(
    addConfigOptions(
      addProjectOption(
        goals
          .command("create")
          .description(
            "Author a goal: a persona, a task, and the environments to pursue it against. Creating does NOT run it — `goals run` does, and that is the call that spends."
          )
          .requiredOption(
            "--goal <text>",
            "What the persona is trying to accomplish"
          )
          .requiredOption("--persona <id>", "Persona ID to run as")
          .option("--name <name>")
          .option("--swarm <id>", "Swarm container ID (authoring provenance)")
          .option(
            "--environment <id>",
            "Environment to fan out across. Repeatable.",
            (value: string, previous: string[] = []) => [...previous, value]
          )
          .option("--idempotency-key <key>", "Retry key")
      ),
      true
    ),
    createGoalOperation,
    (
      options: ProjectOptions & {
        goal: string;
        persona: string;
        name?: string;
        swarm?: string;
        environment?: string[];
        iterations?: string;
        sessionsPerTarget?: string;
        maxTurns: string;
        idempotencyKey?: string;
      }
    ) => ({
      project: options.project,
      goal: options.goal,
      persona: options.persona,
      iterations: requiredIterationsOf(options),
      maxTurns: parseRequiredIntegerOption(
        options.maxTurns,
        "--max-turns",
        TURNS_BOUNDS
      ),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.swarm !== undefined ? { swarm: options.swarm } : {}),
      ...(options.environment?.length
        ? { environmentIds: options.environment }
        : {}),
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    })
  );

  bindOperation(
    addConfigOptions(
      addProjectOption(
        goals
          .command("update")
          .description(
            "Edit a goal. --iterations and --max-turns must be given together (they are one config upstream). A run already in flight keeps the config it launched with."
          )
          .option("--goal-id <id>", "Goal ID")
          .option("--journey <id>", "Deprecated alias for --goal-id")
          .option("--name <name>")
          .option("--goal <text>")
          .option(
            "--environment <id>",
            "Replace the fan-out with these. Repeatable.",
            (value: string, previous: string[] = []) => [...previous, value]
          )
          .option(
            "--clear-environments",
            "Drop the fan-out and return the goal to its host targets."
          )
      ),
      false
    ),
    updateGoalOperation,
    (
      options: ProjectOptions & {
        goalId?: string;
        journey?: string;
        name?: string;
        goal?: string;
        environment?: string[];
        clearEnvironments?: boolean;
        iterations?: string;
        sessionsPerTarget?: string;
        maxTurns?: string;
      }
    ) => {
      if (options.clearEnvironments && options.environment?.length) {
        // Both would mean "set these, and also unset them". Failing here is
        // better than picking one, which would silently do half of what was
        // asked on a field that decides where the goal runs.
        throw new Error(
          "--clear-environments and --environment cannot be used together"
        );
      }
      // One `config` object upstream, so the server rejects a one-sided edit.
      // Saying so here names both flags; the server's message names a nested
      // field the user never typed.
      requireTogether(
        {
          flag: "--iterations",
          value: options.iterations ?? options.sessionsPerTarget,
        },
        { flag: "--max-turns", value: options.maxTurns }
      );
      return {
        project: options.project,
        goalId: goalIdOf(options),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.goal !== undefined ? { goal: options.goal } : {}),
        ...(options.clearEnvironments
          ? { environmentIds: null }
          : options.environment?.length
          ? { environmentIds: options.environment }
          : {}),
        ...(iterationsOf(options) !== undefined
          ? { iterations: iterationsOf(options)! }
          : {}),
        ...(options.maxTurns !== undefined
          ? {
              maxTurns: parseIntegerOption(
                options.maxTurns,
                "--max-turns",
                TURNS_BOUNDS
              ),
            }
          : {}),
      };
    }
  );

  bindOperation(
    addProjectOption(
      goals
        .command("archive")
        .description(
          "Take a goal off the roster. Its runs, sessions and scorecards stay readable — the evidence for past decisions is not deleted with the goal that produced it."
        )
        .option("--goal-id <id>", "Goal ID")
        .option("--journey <id>", "Deprecated alias for --goal-id")
    ),
    archiveGoalOperation,
    (options: ProjectOptions & { goalId?: string; journey?: string }) => ({
      project: options.project,
      goalId: goalIdOf(options),
    })
  );

  bindOperation(
    addGoalCountOption(
      addGroundingOptions(
        addProjectOption(
          goals
            .command("generate")
            .description(
              "Draft candidate goals for a persona with a model. The persona is passed BY VALUE and does not have to exist yet, because the create flow drafts both before saving either. SAVES NOTHING; included with MCPJam (no customer credits consumed) and counts against the organization's daily generation quota."
            )
            .requiredOption("--persona-name <name>")
            .requiredOption("--persona-role <role>")
            .option("--persona-notes <text>")
        )
      )
    ),
    generateGoalsOperation,
    (
      options: ProjectOptions & {
        personaName: string;
        personaRole: string;
        personaNotes?: string;
        environment?: string;
        serverAttachment?: string;
        description?: string;
        goalCount?: string;
        journeyCount?: string;
      }
    ) => ({
      project: options.project,
      persona: {
        name: options.personaName,
        role: options.personaRole,
        ...(options.personaNotes !== undefined
          ? { notes: options.personaNotes }
          : {}),
      },
      ...goalGroundingArgs(options),
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("overview")
        .description(
          "The project's recent runs with their rubric findings and goal-completion trend — the roll-up the Swarms page shows. Rates are over GRADED sessions; passRate null means nothing has been graded, not that everything failed."
        )
    ),
    getSwarmOverviewOperation,
    (options: ProjectOptions) => ({ project: options.project })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("scorecard")
        .description(
          "Per-criterion pass/fail counts for one run. Deterministic — no model involved — so this is the first thing to read when explaining a failure. failedGradingCount is grading that BROKE; do not add it to failCount."
        )
        .requiredOption("--run <id>", "Journey run ID")
    ),
    getGoalRunScorecardOperation,
    (options: ProjectOptions & { run: string }) => ({
      project: options.project,
      run: options.run,
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("findings")
        .description(
          "Criteria that keep failing across waves, with how long each has been failing."
        )
    ),
    listSwarmFindingsOperation,
    (options: ProjectOptions) => ({ project: options.project })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("dismiss-finding")
        .description(
          "Mark a finding as not worth acting on. Its lifecycle keeps updating underneath, so undismissing later shows honest current state."
        )
        .requiredOption("--finding <id>", "Finding ID")
    ),
    dismissSwarmFindingOperation,
    (options: ProjectOptions & { finding: string }) => ({
      project: options.project,
      finding: options.finding,
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("undismiss-finding")
        .description("Bring a dismissed finding back into the active list.")
        .requiredOption("--finding <id>", "Finding ID")
    ),
    undismissSwarmFindingOperation,
    (options: ProjectOptions & { finding: string }) => ({
      project: options.project,
      finding: options.finding,
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("insights")
        .description(
          "The model's analysis of a whole swarm run, if one has been requested. Not-found means nobody asked for it, which is different from asked-and-still-working."
        )
        .option("--swarm-run <id>", "Swarm run ID (the swarmRunId on a run)")
        .option("--wave <id>", "Deprecated alias for --swarm-run")
    ),
    getSwarmRunInsightsOperation,
    (options: ProjectOptions & { swarmRun?: string; wave?: string }) => ({
      project: options.project,
      swarmRun: swarmRunIdOf(options),
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("request-insights")
        .description(
          "Ask a model to analyze a whole swarm run. Returns immediately as pending; poll `goals insights`. Included with MCPJam — no credits are consumed; it counts against a daily insight quota shared with user-testing insights. Read the scorecards first — they cost no quota and usually explain the failure."
        )
        .option("--swarm-run <id>", "Swarm run ID")
        .option("--wave <id>", "Deprecated alias for --swarm-run")
        .option(
          "--force",
          "Regenerate over a swarm run that already has insights. Takes another slice of the daily insight quota."
        )
    ),
    requestSwarmRunInsightsOperation,
    (
      options: ProjectOptions & {
        swarmRun?: string;
        wave?: string;
        force?: boolean;
      }
    ) => ({
      project: options.project,
      swarmRun: swarmRunIdOf(options),
      ...(options.force ? { force: true } : {}),
    })
  );

  bindOperation(
    addProjectOption(
      goals
        .command("cancel-insights")
        .description(
          "Stop an in-flight insights generation. The recovery path for a swarm run stuck pending — without it the only way forward is --force, which takes another slice of the daily insight quota."
        )
        .option("--swarm-run <id>", "Swarm run ID")
        .option("--wave <id>", "Deprecated alias for --swarm-run")
    ),
    cancelSwarmRunInsightsOperation,
    (options: ProjectOptions & { swarmRun?: string; wave?: string }) => ({
      project: options.project,
      swarmRun: swarmRunIdOf(options),
    })
  );

  // ── swarms (containers) ─────────────────────────────────────────────────
  const swarms = program
    .command("swarms")
    .description(
      "Swarm containers group goals authored together and hold their shared execution config. A goal does not need one, but a project authored through the app will have them."
    );

  bindOperation(
    addProjectOption(
      swarms.command("list").description("List the project's swarm containers.")
    ),
    listSwarmsOperation,
    (options: ProjectOptions) => ({ project: options.project })
  );

  bindOperation(
    addProjectOption(
      swarms
        .command("get")
        .description("Show one swarm container.")
        .requiredOption("--swarm <id>", "Swarm container ID")
    ),
    getSwarmOperation,
    (options: ProjectOptions & { swarm: string }) => ({
      project: options.project,
      swarm: options.swarm,
    })
  );

  bindOperation(
    addConfigOptions(
      addProjectOption(
        swarms
          .command("create")
          .description(
            "Create a container to author goals under. Runs nothing."
          )
          .requiredOption("--name <name>")
          .option("--description <text>")
          .option(
            "--environment <id>",
            "Default fan-out for goals authored here. Repeatable.",
            (value: string, previous: string[] = []) => [...previous, value]
          )
          .option("--idempotency-key <key>", "Retry key")
      ),
      true
    ),
    createSwarmOperation,
    (
      options: ProjectOptions & {
        name: string;
        description?: string;
        environment?: string[];
        iterations?: string;
        sessionsPerTarget?: string;
        maxTurns: string;
        idempotencyKey?: string;
      }
    ) => ({
      project: options.project,
      name: options.name,
      iterations: requiredIterationsOf(options),
      maxTurns: parseRequiredIntegerOption(
        options.maxTurns,
        "--max-turns",
        TURNS_BOUNDS
      ),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      ...(options.environment?.length
        ? { environmentIds: options.environment }
        : {}),
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    })
  );

  bindOperation(
    addConfigOptions(
      addProjectOption(
        swarms
          .command("update")
          .description(
            "Edit a swarm container. --iterations and --max-turns must be given together."
          )
          .requiredOption("--swarm <id>", "Swarm container ID")
          .option("--name <name>")
          .option("--description <text>")
          .option(
            "--environment <id>",
            "Replace the default fan-out. Repeatable.",
            (value: string, previous: string[] = []) => [...previous, value]
          )
      ),
      false
    ),
    updateSwarmOperation,
    (
      options: ProjectOptions & {
        swarm: string;
        name?: string;
        description?: string;
        environment?: string[];
        sessionsPerTarget?: string;
        maxTurns?: string;
      }
    ) => ({
      project: options.project,
      swarm: options.swarm,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      ...(options.environment?.length
        ? { environmentIds: options.environment }
        : {}),
      ...(options.sessionsPerTarget !== undefined
        ? {
            sessionsPerTarget: parseIntegerOption(
              options.sessionsPerTarget,
              "--sessions-per-target"
            ),
          }
        : {}),
      ...(options.maxTurns !== undefined
        ? { maxTurns: parseIntegerOption(options.maxTurns, "--max-turns") }
        : {}),
    })
  );

  bindOperation(
    addProjectOption(
      swarms
        .command("archive")
        .description(
          "Take a container off the roster. Goals authored under it keep working — the reference is authoring provenance, not ownership."
        )
        .requiredOption("--swarm <id>", "Swarm container ID")
    ),
    archiveSwarmOperation,
    (options: ProjectOptions & { swarm: string }) => ({
      project: options.project,
      swarm: options.swarm,
    })
  );
}
