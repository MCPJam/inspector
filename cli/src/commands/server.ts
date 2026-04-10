import { Command } from "commander";
import { withEphemeralManager } from "../lib/ephemeral";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parseServerConfig,
} from "../lib/server-config";
import { operationalError, writeResult } from "../lib/output";

export function registerServerCommands(program: Command): void {
  const server = program
    .command("server")
    .description("Inspect MCP server connectivity and capabilities");

  addSharedServerOptions(
    server
      .command("info")
      .description("Get initialization info for an MCP server"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const info = manager.getInitializationInfo(serverId);
        if (!info) {
          throw operationalError(
            "Server connected but did not return initialization info.",
          );
        }

        return info;
      },
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });
}
