import { Command } from "commander";
import { writeCommandDebugArtifact } from "../lib/debug-artifact";
import { withEphemeralManager } from "../lib/ephemeral";
import { createCliRpcLogCollector } from "../lib/rpc-logs";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers";
import { listToolsWithMetadata } from "../lib/server-ops";
import { summarizeServerDoctorTarget } from "../lib/server-doctor";
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
      .option("--params <json>", "Tool parameter object as JSON")
      .option(
        "--debug-out <path>",
        "Write a structured debug artifact to a file",
      ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const primaryCollector = globalOptions.rpc || options.debugOut
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const snapshotCollector = options.debugOut
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};
    const targetSummary = summarizeServerDoctorTarget(target, config);

    let result:
      | {
          status: "completed";
          result: unknown;
        }
      | undefined;
    let commandError: unknown;

    try {
      result = await withEphemeralManager(
        config,
        async (manager, serverId) => ({
          status: "completed" as const,
          result: await manager.executeTool(serverId, options.name as string, params),
        }),
        {
          timeout: globalOptions.timeout,
          rpcLogger: primaryCollector?.rpcLogger,
        },
      );
    } catch (error) {
      commandError = error;
    }

    await writeCommandDebugArtifact({
      outputPath: options.debugOut as string | undefined,
      format: globalOptions.format,
      commandName: "tools call",
      commandInput: {
        toolName: options.name as string,
        params,
      },
      target: targetSummary,
      outcome: commandError
        ? {
            status: "error",
            error: commandError,
          }
        : {
            status: "success",
            result,
          },
      snapshot: options.debugOut
        ? {
            input: {
              config,
              target: targetSummary,
              timeout: globalOptions.timeout,
            },
            collector: snapshotCollector,
          }
        : undefined,
      collectors: [primaryCollector],
    });

    if (commandError) {
      throw commandError;
    }

    writeResult(
      withRpcLogsIfRequested(result, primaryCollector, globalOptions),
      globalOptions.format,
    );
  });
}
