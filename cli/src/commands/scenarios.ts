import type { Command } from "commander";
import {
  PlatformApiError,
  publishScenarioOperation,
  unpublishScenarioOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam scenarios` — user testing.
 *
 * A scenario is a project environment published for people outside the project
 * to talk to through a share link. This group supersedes `mcpjam chatboxes`,
 * which is the same product under its older name and is deprecated.
 *
 * BETA. Publishing is behind a per-organization flag; when it is off for yours
 * the server says so plainly. UNPUBLISHING is deliberately not gated — taking
 * a live scenario down has to keep working for an org that just lost the flag.
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

export function registerScenariosCommands(program: Command): void {
  const scenarios = program
    .command("scenarios")
    .description(
      "Publish project environments for user testing, and take them down again"
    );

  const SCENARIO_MODES = [
    "project_members",
    "invited_only",
    "anyone_with_link",
  ] as const;

  addPlatformOptions(
    scenarios
      .command("publish")
      .description(
        "Publish an environment as a scenario and print its share link. Idempotent — re-publishing returns the existing scenario, with created: false. --name, --description and --mode apply at CREATE TIME, in the same call; on a re-publish they are ignored and the result says overridesIgnored: true (use `mcpjam user-testing update` to change an existing scenario)."
      )
      .requiredOption("--environment <id>", "Project environment ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option("--name <name>", "Scenario name (create time only)")
      .option("--description <text>", "Scenario description (create time only)")
      .option(
        "--mode <mode>",
        "Who may open the share link (create time only): project_members | invited_only | anyone_with_link"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        name?: string;
        description?: string;
        mode?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      // A misspelled mode is a usage error, answered here — not a server round
      // trip that spends a request to learn the flag was typed wrong.
      const mode = options.mode as (typeof SCENARIO_MODES)[number] | undefined;
      if (mode !== undefined && !SCENARIO_MODES.includes(mode)) {
        command.error(
          `error: option '--mode <mode>' must be one of ${SCENARIO_MODES.join(
            ", "
          )}`
        );
      }
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          publishScenarioOperation.execute(
            {
              project: options.project,
              environment: options.environment,
              ...(options.name !== undefined ? { name: options.name } : {}),
              ...(options.description !== undefined
                ? { description: options.description }
                : {}),
              ...(mode !== undefined ? { mode } : {}),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    scenarios
      .command("unpublish")
      .description(
        "Take an environment's scenario down, invalidating its share link and any live guest sessions. Idempotent."
      )
      .requiredOption("--environment <id>", "Project environment ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          unpublishScenarioOperation.execute(
            { project: options.project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
