import { swarmVerdictLabel } from "@mcpjam/sdk/contract";
import type { Command } from "commander";
import {
  launchGoalRunOperation,
  cancelGoalRunOperation,
  getGoalRunOperation,
  listGoalRunSessionsOperation,
  listGoalRunsOperation,
  listGoalsOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam cloud goals` — the CLI for what the product calls **Swarms**.
 *
 * A goal is one persona pursuing a task against one or more environments;
 * a goal RUN is what executing it produces. Those are the nouns here, not
 * "swarm", because a swarm is a container users author in the UI and the word
 * is badly overloaded in the codebase — `kind:"swarm"` and `swarmId` refer to
 * the *user-testing* product, which is `mcpjam cloud scenarios`.
 *
 * BETA. Swarms is behind a per-organization flag. These reads work for any
 * project member; the writes (`run`, `cancel`) come back with a clear
 * "not currently available for your organization" error when the flag is off
 * for yours — the server decides, this CLI does not pre-guess, matching how
 * `environments` and `images` behave for features an org lacks.
 */

/** Commander's collector for a repeatable option (`--environment a --environment b`). */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

type PageOptions = { cursor?: string; limit?: string };

/**
 * Commander hands option values back as strings, and these commands call
 * `operation.execute()` directly — the SDK's Zod input schema never runs. So
 * the range lives here or nowhere.
 *
 * It used to live nowhere. A previous version dropped anything that failed
 * `Number.isFinite`, which meant `--limit nope` sent NO limit and returned a
 * default page: the caller asked for something specific, got something else,
 * and was told nothing. `0` and `201` went through untouched for the server to
 * default or clamp. Silently substituting a different request is the one
 * outcome a CLI should never have — refuse instead.
 */
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;

function pageArgs(options: PageOptions): { cursor?: string; limit?: number } {
  let limit: number | undefined;
  if (options.limit !== undefined) {
    limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
      throw usageError(
        `--limit must be a whole number between ${LIMIT_MIN} and ${LIMIT_MAX} (got "${options.limit}")`
      );
    }
  }
  return {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function addPageOptions(command: Command): Command {
  return command
    .option("--cursor <cursor>", "Page cursor from a previous response")
    .option("--limit <n>", "Items per page (1-200)");
}

/**
 * Returns the `goals` group so the authoring and insight subcommands in
 * `./swarms.ts` can hang off the SAME group. A user should not have to learn
 * that `goals run` and `goals create` come from different files.
 */
/**
 * Resolve the goal selector, refusing both spellings at once.
 *
 * `--goal-id`, not `--goal`: a goal's own task text is what `goals create` and
 * `goals update` take as `--goal`, so the id needs the suffix.
 */
export function goalIdOf(options: {
  goalId?: string;
  journey?: string;
}): string {
  if (options.goalId !== undefined && options.journey !== undefined) {
    throw usageError(
      "Use either --goal-id or its deprecated --journey alias, not both."
    );
  }
  const selected = options.goalId ?? options.journey;
  if (selected === undefined) {
    throw usageError("Missing required option: --goal-id");
  }
  return selected;
}

/**
 * The swarm run id, from whichever spelling was given, or `undefined`.
 *
 * `--swarm-run` is the public name; `--wave` is the pre-rename spelling, kept
 * so existing scripts keep running. Passing both is refused rather than
 * resolved by precedence: sibling runs of one batch are linked by this id, and
 * picking one silently would split a batch in two.
 *
 * Here rather than in `swarms.ts` because both files need it and `swarms.ts`
 * already imports from this one; the reverse would be a cycle. It returns
 * `undefined` for the optional case (`goals run`), and `swarms.ts` wraps it
 * for the commands that require one.
 */
export function foldSwarmRunId(options: {
  swarmRun?: string;
  wave?: string;
}): string | undefined {
  if (options.swarmRun !== undefined && options.wave !== undefined) {
    throw usageError(
      "Use either --swarm-run or its deprecated --wave alias, not both."
    );
  }
  return options.swarmRun ?? options.wave;
}

export function registerGoalsCommands(program: Command): Command {
  const goals = program
    .command("goals")
    // The pre-rename name. Kept so a script written against `cloud journeys`
    // keeps running; removed at GA with the rest of the deprecated surface.
    .alias("journeys")
    .description(
      "List goals and inspect their runs (the Swarms product) in your hosted MCPJam projects"
    );

  goals
    .command("list")
    .description("List the goals in a project")
    .option(
      "--project <id-or-name>",
      "Project name or ID (defaults to the most recently updated project)"
    )
    .action(
      async (options: PlatformOptions & { project?: string }, command) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            listGoalsOperation.execute(
              { project: resolveCloudProjectArgs(options).project },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  addPageOptions(
    goals
      .command("runs")
      .description("List a goal's runs, newest first")
      .option("--goal-id <id>", "Goal ID (from `goals list`)")
      .option("--journey <id>", "Deprecated alias for --goal-id")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions &
        PageOptions & {
          project?: string;
          goalId?: string;
          journey?: string;
        },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listGoalRunsOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
              goalId: goalIdOf(options),
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  goals
    .command("status")
    .description(
      "Show one run's status, target rollups, and per-session attempts. Poll this after launching; `status` leaves 'running' once every attempt has settled. A run someone stopped reports 'failed' with canceled: true."
    )
    .requiredOption("--run <id>", "Goal run ID")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string; run: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            getGoalRunOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                run: options.run,
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  goals
    .command("run")
    .description(
      "Launch a goal. Returns as soon as the run exists — poll `goals status` for progress."
    )
    .option("--goal-id <id>", "Goal ID to launch")
    .option("--journey <id>", "Deprecated alias for --goal-id")
    .option("--project <id-or-name>", "Project name or ID")
    .option(
      "--idempotency-key <key>",
      "Retry key. Pass one: a launch spends model credits, so a retry after a dropped response must not run the goal twice. Replaying a key returns the original run."
    )
    .option(
      "--swarm-run <id>",
      "Opaque id linking the sibling runs of one co-launched batch"
    )
    .option("--wave <id>", "Deprecated alias for --swarm-run")
    .option(
      "--environment <id>",
      "Fan out across this project environment instead of the goal's authored targets (repeatable)",
      collectRepeatable,
      [] as string[]
    )
    .action(
      async (
        options: PlatformOptions & {
          project?: string;
          goalId?: string;
          journey?: string;
          idempotencyKey?: string;
          swarmRun?: string;
          wave?: string;
          environment?: string[];
        },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            launchGoalRunOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                goalId: goalIdOf(options),
                ...(options.idempotencyKey
                  ? { idempotencyKey: options.idempotencyKey }
                  : {}),
                // `swarmRunId`, not `waveId`: the operation renamed its input
                // with the rest of the noun, and the conditional spread means
                // a stale key would be dropped in silence rather than refused.
                ...(foldSwarmRunId(options)
                  ? { swarmRunId: foldSwarmRunId(options)! }
                  : {}),
                ...(options.environment?.length
                  ? { environmentIds: options.environment }
                  : {}),
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  goals
    .command("cancel")
    .description(
      "Stop a running goal run. Idempotent — cancelling an already-cancelled run succeeds; a run that finished on its own conflicts instead."
    )
    .requiredOption("--run <id>", "Goal run ID")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string; run: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            cancelGoalRunOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                run: options.run,
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  addPageOptions(
    goals
      .command("sessions")
      .description(
        "List the chat sessions a run produced, with readiness and goal scores"
      )
      .requiredOption("--run <id>", "Goal run ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions &
        PageOptions & {
          project?: string;
          run: string;
        },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listGoalRunSessionsOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
              run: options.run,
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(
        globalOptions.format === "human"
          ? {
              ...result,
              items: result.items.map((row) => ({
                ...row,
                goalResult: swarmVerdictLabel(row.verdict),
              })),
            }
          : result,
        globalOptions.format
      );
    }
  );

  return goals;
}
