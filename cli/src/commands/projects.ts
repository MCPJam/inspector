import type { Command } from "commander";
import {
  listProjectsOperation,
  listProjectServersOperation,
  PlatformApiError,
  showServersOperation,
} from "@mcpjam/sdk/platform";
import {
  formatProjectServersHuman,
  formatProjectsHuman,
  formatShowServersHuman,
} from "../lib/projects-render.js";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
  project?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>,
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        },
      ),
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    // When OUR deadline fired, surface the armed TIMEOUT error: depending
    // on the fetch implementation, the rejection may be a bare AbortError
    // that would otherwise map to INTERNAL_ERROR.
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

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command("projects")
    .description("Operate the MCP servers saved in your hosted MCPJam projects");

  addPlatformOptions(
    projects.command("list").description("List the projects you can access"),
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectsOperation.execute({}, { client, signal }),
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectsHuman(result.items)}\n`);
    } else {
      // Operation payload verbatim — keeps pagination fields like
      // nextCursor, matching the sibling commands and the MCP tool.
      writeResult(result, globalOptions.format);
    }
  });

  addPlatformOptions(
    projects
      .command("servers")
      .description("List the servers saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectServersOperation.execute(
          { project: options.project },
          { client, signal },
        ),
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectServersHuman(result)}\n`);
    } else {
      writeResult(result, globalOptions.format);
    }
  });

  addPlatformOptions(
    projects
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)",
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const payload = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        showServersOperation.execute(
          { project: options.project },
          { client, signal },
        ),
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
