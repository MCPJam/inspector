import { Command } from "commander";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import { exportServerSnapshot } from "../lib/server-ops";
import {
  addSharedServerOptions,
  describeTarget,
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
      async (manager, serverId) => {
        const info = manager.getInitializationInfo(serverId);
        if (!info) {
          throw operationalError(
            "Server connected but did not return initialization info.",
          );
        }

        return info;
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server
      .command("validate")
      .description("Connect to a server and verify the debugger surface works"),
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
      async (manager, serverId) => {
        await manager.getToolsForAiSdk([serverId]);
        return {
          success: true,
          status: "connected",
          target,
          initInfo: manager.getInitializationInfo(serverId) ?? null,
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server.command("ping").description("Ping an MCP server"),
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
      async (manager, serverId) => ({
        target,
        status: "connected",
        result: await manager.pingServer(serverId),
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server
      .command("capabilities")
      .description("Get resolved server capabilities"),
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
      async (manager, serverId) => ({
        target,
        capabilities: manager.getServerCapabilities(serverId) ?? null,
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server.command("export").description("Export server tools, resources, prompts, and capabilities"),
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
      (manager, serverId) => exportServerSnapshot(manager, serverId, target),
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
