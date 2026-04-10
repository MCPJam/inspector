import { Command } from "commander";
import { withEphemeralManager } from "../lib/ephemeral";
import {
  addSharedServerOptions,
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
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const response = await manager.listPrompts(
          serverId,
          options.cursor ? { cursor: options.cursor } : undefined,
        );

        return {
          prompts: response.prompts ?? [],
          nextCursor: response.nextCursor,
        };
      },
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });

  addSharedServerOptions(
    prompts
      .command("get")
      .description("Get a named prompt from an MCP server")
      .requiredOption("--name <prompt>", "Prompt name")
      .option("--prompt-args <json>", "Prompt arguments as a JSON object"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const promptArguments = parsePromptArguments(options.promptArgs);

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        content: await manager.getPrompt(serverId, {
          name: options.name as string,
          arguments: promptArguments,
        }),
      }),
      { timeout: globalOptions.timeout },
    );

    writeResult(result, globalOptions.format);
  });
}
