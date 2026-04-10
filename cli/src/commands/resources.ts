import { Command } from "commander";
import { listResources, readResource } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parseServerConfig,
} from "../lib/server-config";
import { writeResult } from "../lib/output";

export function registerResourcesCommands(program: Command): void {
  const resources = program
    .command("resources")
    .description("List and read MCP resources");

  addSharedServerOptions(
    resources
      .command("list")
      .description("List resources exposed by an MCP server")
      .option("--cursor <cursor>", "Pagination cursor"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        listResources(manager, { serverId, cursor: options.cursor }),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });

  addSharedServerOptions(
    resources
      .command("read")
      .description("Read a resource from an MCP server")
      .requiredOption("--uri <uri>", "Resource URI"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        readResource(manager, { serverId, uri: options.uri as string }),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });
}
