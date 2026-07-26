import { Command } from "commander";
import { listPrompts, getPrompt } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { buildMrtrBeforeConnect } from "../lib/mrtr-input.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parsePromptArguments,
  parseRetryPolicy,
  parseServerConfig,
  resolveAliasedStringOption,
} from "../lib/server-config.js";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import { usageError, writeResult } from "../lib/output.js";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("List and fetch MCP prompts");

  addHostOption(
    addRetryOptions(
    addSharedServerOptions(
      prompts
        .command("list")
        .description("List prompts exposed by an MCP server")
        .option("--cursor <cursor>", "Pagination cursor"),
    ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
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
        host: host?.connection,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addHostOption(
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
        )
        .option(
          "--interactive",
          "Drive the modern input_required (multi-round-trip) loop: render embedded elicitations to the terminal and collect responses from stdin",
        )
        .option(
          "--yes",
          "With --interactive, run non-interactively: decline every embedded input request instead of prompting",
        ),
    ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
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
    if (options.interactive && options.promptArgs === "-") {
      // `-` drains `process.stdin` for the argument JSON, which is the same
      // stream the interactive collector reads its answers from.
      throw usageError(
        "--interactive cannot be used together with --prompt-args -: " +
          "interactive answers are read from stdin too. Pass the arguments as " +
          "JSON or @path.",
      );
    }
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
        host: host?.connection,
        beforeConnect: buildMrtrBeforeConnect(options),
        interactiveElicitation: options.interactive === true,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });
}
