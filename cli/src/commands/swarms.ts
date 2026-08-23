/**
 * `mcpjam cloud personas` / `mcpjam cloud swarms` / the authoring and insight halves of
 * `mcpjam cloud journeys` — the rest of the Swarms product on the command line.
 *
 * `commands/journeys.ts` already covers the run loop (list, run, status,
 * sessions, cancel). What it could not do is AUTHOR anything: a journey needs a
 * persona, and there was no way to make one outside the app. These commands
 * close that, and add the insight reads that turn a finished run into an
 * answer.
 *
 * They live here rather than in `journeys.ts` because that file is about the
 * run loop and is already 340 lines of it; splitting on "run it" versus "make
 * it and read what it meant" keeps both readable. The `journeys` group itself
 * is extended in place — a user should not have to learn that `journeys run`
 * and `journeys create` come from different files.
 *
 * BETA. Authoring is behind a per-organization flag. The commands exist
 * regardless and the server says plainly when the flag is off for yours: a
 * command that answers "not currently available for your organization" is a
 * better answer than a command that does not exist. `mcpjam cloud projects capabilities` asks
 * the question directly.
 */
import type { Command } from "commander";
import {
  archiveJourneyOperation,
  archiveSwarmOperation,
  cancelWaveInsightsOperation,
  createJourneyOperation,
  createPersonaOperation,
  createSwarmOperation,
  deletePersonaOperation,
  dismissSwarmFindingOperation,
  generateJourneysOperation,
  generatePersonasOperation,
  getJourneyOperation,
  getJourneyRunScorecardOperation,
  getPersonaOperation,
  getSwarmOperation,
  getSwarmOverviewOperation,
  getWaveInsightsOperation,
  listPersonasOperation,
  listSwarmFindingsOperation,
  listSwarmsOperation,
  requestWaveInsightsOperation,
  undismissSwarmFindingOperation,
  updateJourneyOperation,
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
function groundingArgs(options: {
  environment?: string;
  serverAttachment?: string;
  description?: string;
  journeyCount?: string;
}) {
  requireExactlyOne({
    "--environment": options.environment,
    "--server-attachment": options.serverAttachment,
  });
  const journeyCount = parseIntegerOption(
    options.journeyCount,
    "--journey-count",
    JOURNEY_COUNT_BOUNDS
  );
  return {
    ...(options.environment ? { environmentId: options.environment } : {}),
    ...(options.serverAttachment
      ? { serverAttachmentId: options.serverAttachment }
      : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(journeyCount !== undefined ? { journeyCount } : {}),
  };
}

type ProjectOptions = PlatformOptions & { project?: string };

/**
 * The two execution knobs, on the commands that take them.
 *
 * `--sessions-per-target` is the one worth reading twice: total sessions is
 * targets x this, and the total is what spends. Four environments at 10
 * sessions each is 40 conversations, not 10.
 */
function addConfigOptions(command: Command, required: boolean): Command {
  const sessions = "--sessions-per-target <n>";
  const turns = "--max-turns <n>";
  const sessionsHelp =
    "Sessions run against EACH target. Total sessions = targets x this, and the total is what spends.";
  const turnsHelp = "Cap on assistant turns per session.";
  return required
    ? command
        .requiredOption(sessions, sessionsHelp)
        .requiredOption(turns, turnsHelp)
    : command.option(sessions, sessionsHelp).option(turns, turnsHelp);
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
    .option("--journey-count <n>", "How many journeys to draft per persona.");
}

export function registerSwarmAuthoringCommands(
  program: Command,
  journeys: Command
): void {
  // ── personas ────────────────────────────────────────────────────────────
  const personas = program
    .command("personas")
    .description(
      "The reusable synthetic characters Swarms journeys run as. A persona carries a name, a role and behavioural notes; the goal lives on each journey."
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
          "Take a persona off the roster. SOFT: finished runs and sessions keep resolving it, so history stays readable, but it cannot be used for new journeys and a second delete answers not-found."
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
            "Draft candidate personas with a model, grounded in what the project's servers do. SAVES NOTHING — pipe what you want into `personas create`. Spends."
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

  // ── journeys: authoring + insights, added to the existing group ──────────

  bindOperation(
    addProjectOption(
      journeys
        .command("get")
        .description(
          "Show one journey in full. Read this before launching if you want to know what a run will cost: it produces targets x sessionsPerTarget conversations."
        )
        .requiredOption("--journey <id>", "Journey ID")
    ),
    getJourneyOperation,
    (options: ProjectOptions & { journey: string }) => ({
      project: options.project,
      journey: options.journey,
    })
  );

  bindOperation(
    addConfigOptions(
      addProjectOption(
        journeys
          .command("create")
          .description(
            "Author a journey: a persona, a goal, and the environments to pursue it against. Creating does NOT run it — `journeys run` does, and that is the call that spends."
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
    createJourneyOperation,
    (
      options: ProjectOptions & {
        goal: string;
        persona: string;
        name?: string;
        swarm?: string;
        environment?: string[];
        sessionsPerTarget: string;
        maxTurns: string;
        idempotencyKey?: string;
      }
    ) => ({
      project: options.project,
      goal: options.goal,
      persona: options.persona,
      sessionsPerTarget: parseRequiredIntegerOption(
        options.sessionsPerTarget,
        "--sessions-per-target",
        SESSIONS_BOUNDS
      ),
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
        journeys
          .command("update")
          .description(
            "Edit a journey. --sessions-per-target and --max-turns must be given together (they are one config upstream). A run already in flight keeps the config it launched with."
          )
          .requiredOption("--journey <id>", "Journey ID")
          .option("--name <name>")
          .option("--goal <text>")
          .option(
            "--environment <id>",
            "Replace the fan-out with these. Repeatable.",
            (value: string, previous: string[] = []) => [...previous, value]
          )
          .option(
            "--clear-environments",
            "Drop the fan-out and return the journey to its host targets."
          )
      ),
      false
    ),
    updateJourneyOperation,
    (
      options: ProjectOptions & {
        journey: string;
        name?: string;
        goal?: string;
        environment?: string[];
        clearEnvironments?: boolean;
        sessionsPerTarget?: string;
        maxTurns?: string;
      }
    ) => {
      if (options.clearEnvironments && options.environment?.length) {
        // Both would mean "set these, and also unset them". Failing here is
        // better than picking one, which would silently do half of what was
        // asked on a field that decides where the journey runs.
        throw new Error(
          "--clear-environments and --environment cannot be used together"
        );
      }
      // One `config` object upstream, so the server rejects a one-sided edit.
      // Saying so here names both flags; the server's message names a nested
      // field the user never typed.
      requireTogether(
        { flag: "--sessions-per-target", value: options.sessionsPerTarget },
        { flag: "--max-turns", value: options.maxTurns }
      );
      return {
        project: options.project,
        journey: options.journey,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.goal !== undefined ? { goal: options.goal } : {}),
        ...(options.clearEnvironments
          ? { environmentIds: null }
          : options.environment?.length
          ? { environmentIds: options.environment }
          : {}),
        ...(options.sessionsPerTarget !== undefined
          ? {
              sessionsPerTarget: parseIntegerOption(
                options.sessionsPerTarget,
                "--sessions-per-target",
                SESSIONS_BOUNDS
              ),
            }
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
      journeys
        .command("archive")
        .description(
          "Take a journey off the roster. Its runs, sessions and scorecards stay readable — the evidence for past decisions is not deleted with the journey that produced it."
        )
        .requiredOption("--journey <id>", "Journey ID")
    ),
    archiveJourneyOperation,
    (options: ProjectOptions & { journey: string }) => ({
      project: options.project,
      journey: options.journey,
    })
  );

  bindOperation(
    addGroundingOptions(
      addProjectOption(
        journeys
          .command("generate")
          .description(
            "Draft candidate journeys for a persona with a model. The persona is passed BY VALUE and does not have to exist yet, because the create flow drafts both before saving either. SAVES NOTHING; spends."
          )
          .requiredOption("--persona-name <name>")
          .requiredOption("--persona-role <role>")
          .option("--persona-notes <text>")
      )
    ),
    generateJourneysOperation,
    (
      options: ProjectOptions & {
        personaName: string;
        personaRole: string;
        personaNotes?: string;
        environment?: string;
        serverAttachment?: string;
        description?: string;
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
      ...groundingArgs(options),
    })
  );

  bindOperation(
    addProjectOption(
      journeys
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
      journeys
        .command("scorecard")
        .description(
          "Per-criterion pass/fail counts for one run. Deterministic — no model involved — so this is the first thing to read when explaining a failure. failedGradingCount is grading that BROKE; do not add it to failCount."
        )
        .requiredOption("--run <id>", "Journey run ID")
    ),
    getJourneyRunScorecardOperation,
    (options: ProjectOptions & { run: string }) => ({
      project: options.project,
      run: options.run,
    })
  );

  bindOperation(
    addProjectOption(
      journeys
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
      journeys
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
      journeys
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
      journeys
        .command("insights")
        .description(
          "The model's analysis of a whole wave, if one has been requested. Not-found means nobody asked for it, which is different from asked-and-still-working."
        )
        .requiredOption("--wave <id>", "Wave ID (the waveId on a run)")
    ),
    getWaveInsightsOperation,
    (options: ProjectOptions & { wave: string }) => ({
      project: options.project,
      wave: options.wave,
    })
  );

  bindOperation(
    addProjectOption(
      journeys
        .command("request-insights")
        .description(
          "Ask a model to analyze a whole wave. Returns immediately as pending; poll `journeys insights`. SPENDS against a daily budget shared with user-testing insights. Read the scorecards first — they are free and usually explain the failure."
        )
        .requiredOption("--wave <id>", "Wave ID")
        .option(
          "--force",
          "Regenerate over a wave that already has insights. Spends again."
        )
    ),
    requestWaveInsightsOperation,
    (options: ProjectOptions & { wave: string; force?: boolean }) => ({
      project: options.project,
      wave: options.wave,
      ...(options.force ? { force: true } : {}),
    })
  );

  bindOperation(
    addProjectOption(
      journeys
        .command("cancel-insights")
        .description(
          "Stop an in-flight insights generation. The recovery path for a wave stuck pending — without it the only way forward is --force, which spends again."
        )
        .requiredOption("--wave <id>", "Wave ID")
    ),
    cancelWaveInsightsOperation,
    (options: ProjectOptions & { wave: string }) => ({
      project: options.project,
      wave: options.wave,
    })
  );

  // ── swarms (containers) ─────────────────────────────────────────────────
  const swarms = program
    .command("swarms")
    .description(
      "Swarm containers group journeys authored together and hold their shared execution config. A journey does not need one, but a project authored through the app will have them."
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
            "Create a container to author journeys under. Runs nothing."
          )
          .requiredOption("--name <name>")
          .option("--description <text>")
          .option(
            "--environment <id>",
            "Default fan-out for journeys authored here. Repeatable.",
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
        sessionsPerTarget: string;
        maxTurns: string;
        idempotencyKey?: string;
      }
    ) => ({
      project: options.project,
      name: options.name,
      sessionsPerTarget: parseRequiredIntegerOption(
        options.sessionsPerTarget,
        "--sessions-per-target",
        SESSIONS_BOUNDS
      ),
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
            "Edit a swarm container. --sessions-per-target and --max-turns must be given together."
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
          "Take a container off the roster. Journeys authored under it keep working — the reference is authoring provenance, not ownership."
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
