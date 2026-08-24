import type { Command } from "commander";
import {
  getScenarioOperation,
  listScenariosOperation,
  publishScenarioOperation,
  unpublishScenarioOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam cloud scenarios` — user testing.
 *
 * A scenario is a project environment published for people outside the project
 * to talk to through a share link.
 *
 * The read commands (`list`, `get`) used to live in `commands/chat.ts` under
 * the surface's older name. They are here now: two groups cannot both register
 * `scenarios`, and splitting reads from writes across two files was only ever
 * an artifact of the old name.
 *
 * BETA. Publishing is behind a per-organization flag; when it is off for yours
 * the server says so plainly. UNPUBLISHING is deliberately not gated — taking
 * a live scenario down has to keep working for an org that just lost the flag.
 */




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

      scenarios
      .command("list")
      .description("List the scenarios published from a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      platformOptionsOf(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listScenariosOperation.execute(
          {
            project: resolveCloudProjectArgs(options).project,
          },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      scenarios
      .command("get")
      .description(
        "Show one scenario: access mode, attached servers, share link"
      )
      .requiredOption("--scenario <id-or-name>", "Scenario name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(
    async (
      options: PlatformOptions & { scenario: string; project?: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getScenarioOperation.execute(
            {
              scenario: options.scenario,
              project: resolveCloudProjectArgs(options).project,
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      scenarios
      .command("publish")
      .description(
        "Publish an environment as a scenario and print its share link. Idempotent — re-publishing returns the existing scenario, with created: false. --name, --description and --mode apply at CREATE TIME, in the same call; on a re-publish they are ignored and the result says overridesIgnored: true (use `mcpjam cloud user-testing update` to change an existing scenario)."
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
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          publishScenarioOperation.execute(
            {
              project: resolveCloudProjectArgs(options).project,
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

      scenarios
      .command("unpublish")
      .description(
        "Take an environment's scenario down, invalidating its share link and any live guest sessions. Idempotent."
      )
      .requiredOption("--environment <id>", "Project environment ID")
      .option("--project <id-or-name>", "Project name or ID").action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          unpublishScenarioOperation.execute(
            { project: resolveCloudProjectArgs(options).project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
