import { Command } from "commander";
import { listTools } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parseJsonRecord,
  parseServerConfig,
} from "../lib/server-config";
import { writeResult } from "../lib/output";

export function registerToolsCommands(program: Command): void {
  const tools = program
    .command("tools")
    .description("List and invoke MCP server tools");

  addSharedServerOptions(
    tools
      .command("list")
      .description("List tools exposed by an MCP server")
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
        listTools(manager, { serverId, cursor: options.cursor }),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });

  addSharedServerOptions(
    tools
      .command("call")
      .description("Call an MCP tool")
      .requiredOption("--name <tool>", "Tool name")
      .option("--params <json>", "Tool parameter object as JSON"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        manager.executeTool(serverId, options.name as string, params),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });
}
