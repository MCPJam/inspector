import { Command } from "commander";
import { listPrompts, getPrompt } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parsePromptArguments,
  parseRetryPolicy,
  parseServerConfig,
  resolveAliasedStringOption,
} from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("List and fetch MCP prompts");

  addRetryOptions(
    addSharedServerOptions(
      prompts
        .command("list")
        .description("List prompts exposed by an MCP server")
        .option("--cursor <cursor>", "Pagination cursor"),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
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
        retryPolicy,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addRetryOptions(
    addSharedServerOptions(
      prompts
        .command("get")
        .description("Get a named prompt from an MCP server")
        .option("--prompt-name <prompt>", "Prompt name")
        .option("--name <prompt>", "Alias for --prompt-name")
        .option(
          "--prompt-args <json>",
          "Prompt arguments as JSON, @path, or - for stdin",
        ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const promptName = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "promptName", flag: "--prompt-name" },
        { key: "name", flag: "--name" },
      ],
      "Prompt name",
      { required: true },
    ) as string;
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
          name: promptName,
          arguments: promptArguments,
        }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });
}
