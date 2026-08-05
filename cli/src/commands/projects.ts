import type { Command } from "commander";
import {
  createProjectOperation,
  deleteProjectOperation,
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  PlatformApiError,
  showServersOperation,
  updateProjectOperation,
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
    .description(
      "Operate the MCP servers saved in your hosted MCPJam projects"
    );

  addPlatformOptions(
    projects.command("list").description("List the projects you can access")
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectsOperation.execute({}, { client, signal })
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
      .command("create")
      .description("Create a hosted MCPJam project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--organization-id <id>", "Organization ID")
      .option("--visibility <visibility>", "public or private")
  ).action(
    async (
      options: PlatformOptions & {
        name: string;
        description?: string;
        organizationId?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const input = createProjectOperation.inputSchema.parse({
        name: options.name,
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.organizationId === undefined
          ? {}
          : { organizationId: options.organizationId }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          createProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    projects
      .command("update")
      .description("Update project metadata")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New project name")
      .option("--description <text>", "New project description")
      .option("--visibility <visibility>", "public or private")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        name?: string;
        description?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const input = updateProjectOperation.inputSchema.parse({
        project: options.project,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    projects
      .command("delete")
      .description("Delete a project and its project-owned resources")
      .requiredOption("--project <id-or-name>", "Project name or ID")
  ).action(async (options: PlatformOptions & { project: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = deleteProjectOperation.inputSchema.parse({
      project: options.project,
    });
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  const servers = addPlatformOptions(
    projects
      .command("servers")
      .alias("server")
      .description("List and manage the servers saved in a project")
  ).option(
    "--project <id-or-name>",
    "Project name or ID (defaults to the most recently updated project)"
  );
  servers.action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectServersOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectServersHuman(result)}\n`);
    } else {
      writeResult(result, globalOptions.format);
    }
  });

  const parseBody = (raw: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  };

  addPlatformOptions(
    servers
      .command("create")
      .alias("add")
      .description("Create a saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--body <json>", "Server JSON body")
  ).action(async (options: PlatformOptions & { body: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        createProjectServerOperation.execute(
          { project: options.project, body: parseBody(options.body) as never },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    servers
      .command("get")
      .description("Get one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
  ).action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        getProjectServerOperation.execute(
          { project: options.project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    servers
      .command("update")
      .description("Update one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
      .requiredOption("--body <json>", "Patch JSON body")
  ).action(
    async (
      options: PlatformOptions & { server: string; body: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectServerOperation.execute(
            {
              project: options.project,
              serverId: options.server,
              body: parseBody(options.body),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    servers
      .command("delete")
      .alias("remove")
      .description("Delete one saved MCP server")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
  ).action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectServerOperation.execute(
          { project: options.project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    projects
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const payload = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        showServersOperation.execute(
          { project: options.project },
          { client, signal }
        )
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
