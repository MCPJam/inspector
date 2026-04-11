import { Command } from "commander";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import { listToolsWithMetadata } from "../lib/server-ops";
import {
  addSharedServerOptions,
  describeTarget,
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
      .option("--cursor <cursor>", "Pagination cursor")
      .option("--model-id <model>", "Model id used for token counting"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        listToolsWithMetadata(manager, {
          serverId,
          cursor: options.cursor,
          modelId: options.modelId,
        }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    tools
      .command("call")
      .description("Call an MCP tool")
      .requiredOption("--name <tool>", "Tool name")
      .option("--params <json>", "Tool parameter object as JSON"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        status: "completed",
        result: await manager.executeTool(serverId, options.name as string, params),
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
}

function withRpcLogsIfRequested(
  value: unknown,
  collector: ReturnType<typeof createCliRpcLogCollector> | undefined,
  options: { format: string; rpc: boolean },
) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }

  return attachCliRpcLogs(value, collector);
}
