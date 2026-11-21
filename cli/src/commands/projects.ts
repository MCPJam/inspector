import type { Command } from "commander";
import {
  createProjectOperation,
  deleteProjectOperation,
  getCapabilitiesOperation,
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  showServersOperation,
  updateProjectOperation,
} from "@mcpjam/sdk/platform";
import {
  formatProjectServersHuman,
  formatProjectsHuman,
  formatShowServersHuman,
} from "../lib/projects-render.js";
import { writeResult } from "../lib/output.js";
import {
  addOrgOption,
  addProjectOption,
  bindOperation,
  platformOptionsOf,
  runPlatformCommand,
  type PlatformOptions as SharedPlatformOptions,
} from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { registerServerConnectCommands } from "./server-connect.js";
import { registerServerRevisionCommands } from "./server-revisions.js";

type PlatformOptions = SharedPlatformOptions & {
  project?: string;
};

/**
 * `--project`, for the commands that cannot run without one.
 *
 * These used to be `requiredOption`, which the `servers` group's own
 * `--project` made unsatisfiable — Commander consumed the value at the group
 * and then failed the subcommand for not having it, so `projects servers get
 * --project alpha --server srv-1` could not be typed at all. Enforcing it here
 * keeps the same outcome for the same mistake (`command.error` raises the
 * `CommanderError` the CLI already maps to a usage error) while letting the
 * value arrive from wherever Commander actually put it. See
 * {@link platformOptionsOf} for why flags on the group and the leaf must be
 * merged nearest-first.
 */
function requireProject(command: Command, options: PlatformOptions): string {
  const resolved = resolveCloudProjectArgs({ project: options.project });
  if (resolved.projectScope.source === "automatic" || !resolved.project) {
    command.error("error: required option '--project <id-or-name>' not specified");
  }
  return resolved.project;
}

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command("projects")
    .description(
      "Operate the MCP servers saved in your hosted MCPJam projects"
    );

      addOrgOption(
      projects
      .command("list")
      .description("List the projects you can access")
      // The operation has always taken this filter; the CLI had no way to pass
      // it, and no way to learn an id to pass either. `organizations list`
      // supplies the id, so the flag is finally usable end to end.
      //
      // Named `--org`, matching `projects create`. Both take an ID and only
      // an ID. (`--project` elsewhere is a name-OR-id selector.)
      ).action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const rawOrganization = (command.opts() as { org?: string }).org;
    // A supplied-but-blank value is a typo, not "no filter". Silently widening
    // it to every accessible project is the wrong answer to a request that
    // asked to narrow — same reasoning as `requireProject` above.
    if (rawOrganization !== undefined && rawOrganization.trim() === "") {
      command.error(
        "error: option '--org <id>' cannot be empty"
      );
    }
    const organizationId = rawOrganization?.trim();
    const result = await runPlatformCommand(
      platformOptionsOf<PlatformOptions>(command),
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectsOperation.execute(
          organizationId ? { organizationId } : {},
          { client, signal }
        ),
      {
        quiet: globalOptions.quiet,
        cloudScope: organizationId
          ? { kind: "organization", organization: organizationId }
          : { kind: "all-projects" },
      }
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectsHuman(result.items)}\n`);
    } else {
      // Operation payload verbatim — keeps pagination fields like
      // nextCursor, matching the sibling commands and the MCP tool.
      writeResult(result, globalOptions.format);
    }
  });

      addOrgOption(
      projects
      .command("create")
      .description("Create a hosted MCPJam project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      )
      .option("--visibility <visibility>", "public or private").action(
    async (
      options: PlatformOptions & {
        name: string;
        description?: string;
        org?: string;
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
        ...(options.org === undefined
          ? {}
          : { organizationId: options.org }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        platformOptionsOf<PlatformOptions>(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          createProjectOperation.execute(input, { client, signal }),
        { cloudScope: { kind: "account" }, quiet: globalOptions.quiet }
      );
      writeResult(result, globalOptions.format);
    }
  );

      projects
      .command("update")
      .description("Update project metadata")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New project name")
      .option("--description <text>", "New project description")
      .option("--visibility <visibility>", "public or private").action(
    async (
      options: PlatformOptions & {
        name?: string;
        description?: string;
        visibility?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const platformOptions = platformOptionsOf<PlatformOptions>(command);
      const input = updateProjectOperation.inputSchema.parse({
        project: requireProject(command, platformOptions),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.visibility === undefined
          ? {}
          : { visibility: options.visibility }),
      });
      const result = await runPlatformCommand(
        platformOptions,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

      projects
      .command("delete")
      .description("Delete a project and its project-owned resources")
      .requiredOption("--project <id-or-name>", "Project name or ID").action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const input = deleteProjectOperation.inputSchema.parse({
      project: requireProject(command, platformOptions),
    });
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  bindOperation(
    addProjectOption(
      projects
        .command("capabilities")
        .description(
          "Show what you may do in a project: your role, which betas the organization has, your plan's limits, and a can-block of booleans. Ask this before scripting anything that authors, launches or publishes."
        )
    ),
    getCapabilitiesOperation,
    (options: PlatformOptions) => ({ project: options.project })
  );

  const servers =     projects
      .command("servers")
      .description("List and manage the servers saved in a project").option(
    "--project <id-or-name>",
    "Project name or ID (defaults to the most recently updated project)"
  );
  // `servers` lists on its own, and `servers list` is the spelling every other
  // group uses; both run this one action.
  const listServers = async (_options: PlatformOptions, command: Command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        listProjectServersOperation.execute(
          { project: resolveCloudProjectArgs(platformOptions).project },
          { client, signal }
        )
    );

    if (globalOptions.format === "human") {
      process.stdout.write(`${formatProjectServersHuman(result)}\n`);
    } else {
      writeResult(result, globalOptions.format);
    }
  };
  servers.action(listServers);
  servers
    .command("list")
    .description("List the servers saved in a project")
    .option(
      "--project <id-or-name>",
      "Project name or ID (defaults to the most recently updated project)"
    )
    .action(listServers);

  const parseBody = (raw: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  };

      servers
      .command("create")
      .alias("add")
      .description("Create a saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--body <json>", "Server JSON body").action(async (options: PlatformOptions & { body: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        createProjectServerOperation.execute(
          { project, body: parseBody(options.body) as never },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

      servers
      .command("get")
      .description("Get one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID").action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        getProjectServerOperation.execute(
          { project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  registerServerRevisionCommands(servers);

      servers
      .command("update")
      .description("Update one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID")
      .requiredOption("--body <json>", "Patch JSON body").action(
    async (
      options: PlatformOptions & { server: string; body: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const platformOptions = platformOptionsOf<PlatformOptions>(command);
      const project = requireProject(command, platformOptions);
      const result = await runPlatformCommand(
        platformOptions,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateProjectServerOperation.execute(
            {
              project,
              serverId: options.server,
              body: parseBody(options.body),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

      servers
      .command("delete")
      .alias("remove")
      .description("Delete one saved MCP server")
      .option("--project <id-or-name>", "Project name or ID")
      .requiredOption("--server <id>", "Server ID").action(async (options: PlatformOptions & { server: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const project = requireProject(command, platformOptions);
    const result = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        deleteProjectServerOperation.execute(
          { project, serverId: options.server },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  registerServerConnectCommands(servers);

      projects
      .command("status")
      .description(
        "Health-check every server in a project (hosted doctor per server)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      ).action(async (_options: PlatformOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const platformOptions = platformOptionsOf<PlatformOptions>(command);
    const payload = await runPlatformCommand(
      platformOptions,
      globalOptions.timeout,
      ({ client, signal }) =>
        showServersOperation.execute(
          { project: resolveCloudProjectArgs(platformOptions).project },
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
