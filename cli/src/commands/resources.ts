import { Command } from "commander";
import { listResources, readResource } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import {
  addSharedServerOptions,
  describeTarget,
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
        listResources(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    resources
      .command("read")
      .description("Read a resource from an MCP server")
      .requiredOption("--uri <uri>", "Resource URI"),
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
        readResource(manager, { serverId, uri: options.uri as string }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    resources
      .command("templates")
      .description("List resource templates exposed by an MCP server")
      .option("--cursor <cursor>", "Pagination cursor"),
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
        manager.listResourceTemplates(
          serverId,
          options.cursor ? { cursor: options.cursor } : undefined,
        ),
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
