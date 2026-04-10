import { Command } from "commander";
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
      async (manager, serverId) => {
        const response = await manager.listResources(
          serverId,
          options.cursor ? { cursor: options.cursor } : undefined,
        );

        return {
          resources: response.resources ?? [],
          nextCursor: response.nextCursor,
        };
      },
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
      async (manager, serverId) => ({
        content: await manager.readResource(serverId, {
          uri: options.uri as string,
        }),
      }),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });
}
