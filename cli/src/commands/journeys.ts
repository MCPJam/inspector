import type { Command } from "commander";
import {
  launchJourneyRunOperation,
  cancelJourneyRunOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  listJourneyRunsOperation,
  listJourneysOperation,
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
 * `mcpjam cloud journeys` — the CLI for what the product calls **Swarms**.
 *
 * A journey is one persona pursuing a goal against one or more environments;
 * a journey RUN is what executing it produces. Those are the nouns here, not
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
 * Returns the `journeys` group so the authoring and insight subcommands in
 * `./swarms.ts` can hang off the SAME group. A user should not have to learn
 * that `journeys run` and `journeys create` come from different files.
 */
export function registerJourneysCommands(program: Command): Command {
  const journeys = program
    .command("journeys")
    .description(
      "List journeys and inspect their runs (the Swarms product) in your hosted MCPJam projects"
    );

      journeys
      .command("list")
      .description("List the journeys in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listJourneysOperation.execute(
          { project: resolveCloudProjectArgs(options).project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      addPageOptions(
      journeys
        .command("runs")
        .description("List a journey's runs, newest first")
        .requiredOption("--journey <id>", "Journey ID (from `journeys list`)")
        .option("--project <id-or-name>", "Project name or ID")
    ).action(
    async (
      options: PlatformOptions &
        PageOptions & {
          project?: string;
          journey: string;
        },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listJourneyRunsOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
              journey: options.journey,
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      journeys
      .command("status")
      .description(
        "Show one run's status, target rollups, and per-session attempts. Poll this after launching; `status` leaves 'running' once every attempt has settled. A run someone stopped reports 'failed' with canceled: true."
      )
      .requiredOption("--run <id>", "Journey run ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getJourneyRunOperation.execute(
            { project: resolveCloudProjectArgs(options).project, run: options.run },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      journeys
      .command("run")
      .description(
        "Launch a journey. Returns as soon as the run exists — poll `journeys status` for progress."
      )
      .requiredOption("--journey <id>", "Journey ID to launch")
      .option("--project <id-or-name>", "Project name or ID")
      .option(
        "--idempotency-key <key>",
        "Retry key. Pass one: a launch spends model credits, so a retry after a dropped response must not run the journey twice. Replaying a key returns the original run."
      )
      .option(
        "--wave <id>",
        "Opaque id linking the sibling runs of one co-launched batch"
      )
      .option(
        "--environment <id>",
        "Fan out across this project environment instead of the journey's authored targets (repeatable)",
        collectRepeatable,
        [] as string[]
      ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        journey: string;
        idempotencyKey?: string;
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
          launchJourneyRunOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
              journey: options.journey,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
              ...(options.wave ? { waveId: options.wave } : {}),
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

      journeys
      .command("cancel")
      .description(
        "Stop a running journey run. Idempotent — cancelling an already-cancelled run succeeds; a run that finished on its own conflicts instead."
      )
      .requiredOption("--run <id>", "Journey run ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          cancelJourneyRunOperation.execute(
            { project: resolveCloudProjectArgs(options).project, run: options.run },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      addPageOptions(
      journeys
        .command("sessions")
        .description(
          "List the chat sessions a run produced, with readiness and goal scores"
        )
        .requiredOption("--run <id>", "Journey run ID")
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
          listJourneyRunSessionsOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
              run: options.run,
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  return journeys;
}
