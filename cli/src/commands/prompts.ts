import { Command } from "commander";
import { listPrompts, getPrompt } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral";
import { createCliRpcLogCollector } from "../lib/rpc-logs";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parsePromptArguments,
  parseServerConfig,
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
