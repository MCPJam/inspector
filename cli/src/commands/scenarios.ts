import type { Command } from "commander";
import {
  addPlatformOptions,
  runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  publishScenarioOperation,
  unpublishScenarioOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
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

export function registerScenariosCommands(program: Command): void {
  const scenarios = program
    .command("scenarios")
    .description(
      "Publish project environments for user testing, and take them down again"
    );

  addPlatformOptions(
    scenarios
      .command("publish")
      .description(
        "Publish an environment as a scenario and print its share link. Idempotent — re-publishing returns the existing scenario, with created: false."
      )
      .requiredOption("--environment <id>", "Project environment ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
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
          publishScenarioOperation.execute(
            { project: options.project, environment: options.environment },
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
