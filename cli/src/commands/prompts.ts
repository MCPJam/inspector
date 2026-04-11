import { Command } from "commander";
import { listPrompts, getPrompt } from "@mcpjam/sdk";
import { withEphemeralManager, withEphemeralManagers } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import { listPromptsMulti } from "../lib/server-ops";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parsePromptArguments,
  parseServerConfig,
  parseServerTargets,
} from "../lib/server-config";
import { writeResult } from "../lib/output";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("List and fetch MCP prompts");

  addSharedServerOptions(
    prompts
      .command("list")
      .description("List prompts exposed by an MCP server")
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
        listPrompts(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  prompts
    .command("list-multi")
    .description("List prompts across multiple server targets")
    .requiredOption(
      "--servers <json>",
      "JSON array of server target objects with id plus url or command",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const targets = parseServerTargets(options.servers as string);
      const collector = globalOptions.rpc
        ? createCliRpcLogCollector(
            Object.fromEntries(
              targets.map((target) => [target.id, target.name ?? target.id]),
            ),
          )
        : undefined;

      const result = await withEphemeralManagers(
        Object.fromEntries(targets.map((target) => [target.id, target.config])),
        async (manager, connectionErrors) => {
          const promptsResult = await listPromptsMulti(
            manager,
            targets.map((target) => target.id),
          );
          const resultErrors = (promptsResult.errors ?? {}) as Record<
            string,
            string
          >;
          const mergedErrors = {
            ...resultErrors,
            ...connectionErrors,
          };

          return {
            prompts: promptsResult.prompts,
            ...(Object.keys(mergedErrors).length === 0
              ? {}
              : { errors: mergedErrors }),
          };
        },
        {
          timeout: globalOptions.timeout,
          rpcLogger: collector?.rpcLogger,
          continueOnConnectError: true,
        },
      );

      writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
    });

  addSharedServerOptions(
    prompts
      .command("get")
      .description("Get a named prompt from an MCP server")
      .requiredOption("--name <prompt>", "Prompt name")
      .option("--prompt-args <json>", "Prompt arguments as a JSON object"),
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
    const promptArguments = parsePromptArguments(options.promptArgs);

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        getPrompt(manager, {
          serverId,
          name: options.name as string,
          arguments: promptArguments,
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
