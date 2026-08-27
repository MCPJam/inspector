/**
 * `mcpjam cloud skills` — READ-ONLY Cloud Skills commands.
 *
 * These exist to close a loop the CLI could not close on its own: three
 * separate flags here take a skill ID (`eval run --compose-skill`,
 * `eval cases run --compose-skill`, `environments ensure-adhoc --skill`) and
 * until now nothing in the CLI could tell you what those IDs were. The only
 * way to learn one was to open the web app.
 *
 * Authoring stays out of the CLI deliberately, matching `cloud plugins`:
 * creating a skill is a project-admin app flow behind a beta gate, and the
 * public API exposes no skill write.
 */
import type { Command } from "commander";
import {
  getProjectSkillOperation,
  listProjectSkillsOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "List and read the Cloud Skills in your hosted MCPJam projects (read-only; authoring lives in the app)"
    );

  skills
    .command("list")
    .description(
      "List the skills visible to you in a project, with the IDs that --compose-skill and --skill take"
    )
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
            listProjectSkillsOperation.execute(
              { project: resolveCloudProjectArgs(options).project },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );

  skills
    .command("get")
    .description("Show one skill, including its SKILL.md body")
    .requiredOption("--skill <id>", "Skill ID, from `cloud skills list`")
    .option("--project <id-or-name>", "Project name or ID")
    .action(
      async (
        options: PlatformOptions & { project?: string; skill: string },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            getProjectSkillOperation.execute(
              {
                project: resolveCloudProjectArgs(options).project,
                skillId: options.skill,
              },
              { client, signal }
            )
        );
        writeResult(result, globalOptions.format);
      }
    );
}
