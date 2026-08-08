import type { Command } from "commander";
import {
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  listJourneyRunsOperation,
  listJourneysOperation,
  PlatformApiError,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam journeys` — the CLI for what the product calls **Swarms**.
 *
 * A journey is one persona pursuing a goal against one or more environments;
 * a journey RUN is what executing it produces. Those are the nouns here, not
 * "swarm", because a swarm is a container users author in the UI and the word
 * is badly overloaded in the codebase — `kind:"swarm"` and `swarmId` refer to
 * the *user-testing* product, which is `mcpjam scenarios`.
 *
 * BETA. Swarms is behind a per-organization flag. These reads work for any
 * project member; the writes (`run`, `cancel`) come back with a clear
 * "not currently available for your organization" error when the flag is off
 * for yours — the server decides, this CLI does not pre-guess, matching how
 * `environments` and `images` behave for features an org lacks.
 */

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

type PageOptions = { cursor?: string; limit?: string };

/**
 * Commander hands option values back as strings. A bad `--limit` should be a
 * usage error at the API boundary rather than a `NaN` that silently becomes a
 * default page — so pass it through only when it parses, and let the SDK's
 * schema reject anything out of range with a real message.
 */
function pageArgs(options: PageOptions): { cursor?: string; limit?: number } {
  const limit = options.limit !== undefined ? Number(options.limit) : undefined;
  return {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  };
}

function addPageOptions(command: Command): Command {
  return command
    .option("--cursor <cursor>", "Page cursor from a previous response")
    .option("--limit <n>", "Items per page (1-200)");
}

export function registerJourneysCommands(program: Command): void {
  const journeys = program
    .command("journeys")
    .description(
      "List journeys and inspect their runs (the Swarms product) in your hosted MCPJam projects"
    );

  addPlatformOptions(
    journeys
      .command("list")
      .description("List the journeys in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listJourneysOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    addPageOptions(
      journeys
        .command("runs")
        .description("List a journey's runs, newest first")
        .requiredOption("--journey <id>", "Journey ID (from `journeys list`)")
        .option("--project <id-or-name>", "Project name or ID")
    )
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
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          listJourneyRunsOperation.execute(
            {
              project: options.project,
              journey: options.journey,
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    journeys
      .command("status")
      .description(
        "Show one run's status, target rollups, and per-session attempts. Poll this after launching; `status` leaves 'running' once every attempt has settled. A run someone stopped reports 'failed' with canceled: true."
      )
      .requiredOption("--run <id>", "Journey run ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getJourneyRunOperation.execute(
            { project: options.project, run: options.run },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    addPageOptions(
      journeys
        .command("sessions")
        .description(
          "List the chat sessions a run produced, with readiness and goal scores"
        )
        .requiredOption("--run <id>", "Journey run ID")
        .option("--project <id-or-name>", "Project name or ID")
    )
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
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          listJourneyRunSessionsOperation.execute(
            {
              project: options.project,
              run: options.run,
              ...pageArgs(options),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
