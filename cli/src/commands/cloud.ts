import type { Command } from "commander";
import {
  listProjectsOperation,
  listProjectServersOperation,
  showServersOperation,
} from "@mcpjam/sdk/platform";
import {
  formatProjectServersHuman,
  formatProjectsHuman,
  formatShowServersHuman,
} from "../lib/cloud-render.js";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type CloudOptions = {
  apiKey?: string;
  apiUrl?: string;
  project?: string;
};

function addCloudOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    );
}

async function runCloudCommand<TOutput>(
  options: CloudOptions,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
  }) => Promise<TOutput>,
): Promise<TOutput> {
  try {
    const { client } = buildPlatformClient(options);
    return await execute({ client });
  } catch (error) {
    throw toCliError(error);
  }
}

export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command("cloud")
    .description("Operate the MCP servers saved in your hosted MCPJam projects");

  const projects = cloud
    .command("projects")
    .description("Work with hosted MCPJam projects");

  addCloudOptions(
    projects.command("list").description("List the projects you can access"),
  ).action(async (options: CloudOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runCloudCommand(options, ({ client }) =>
      listProjectsOperation.execute({}, { client }),
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectsHuman(result.items)}\n`);
    } else {
      writeResult({ items: result.items }, globalOptions.format);
    }
  });

  const servers = cloud
    .command("servers")
    .description("Work with the MCP servers saved in a project");

  addCloudOptions(
    servers
      .command("list")
      .description("List the servers saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(async (options: CloudOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runCloudCommand(options, ({ client }) =>
      listProjectServersOperation.execute(
        { project: options.project },
        { client },
      ),
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectServersHuman(result)}\n`);
    } else {
      writeResult(result, globalOptions.format);
    }
  });

  addCloudOptions(
    servers
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)",
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(async (options: CloudOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const payload = await runCloudCommand(options, ({ client }) =>
      showServersOperation.execute({ project: options.project }, { client }),
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatShowServersHuman(payload)}\n`);
    } else {
      writeResult(payload, globalOptions.format);
    }
    // Exit 0 even with unreachable servers: this is a status report, not an
    // assertion. CI gating can parse the summary from the JSON payload.
  });
}
