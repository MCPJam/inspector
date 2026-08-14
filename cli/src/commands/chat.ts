/**
 * Read-only views of the conversational surfaces: published chatboxes and the
 * chat sessions they (and the in-app Playground) produced.
 *
 * These operations shipped in the SDK and the MCP catalog but had no CLI
 * binding, which made them unreachable from a script — you could ask an agent
 * about your chatboxes but not `grep` them in CI. Reads only: publishing,
 * rotating a share link and managing members stay in the app, where the
 * confirmation flows live.
 */
import type { Command } from "commander";
import {
  addPlatformOptions,
  runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  getChatboxOperation,
  listChatSessionsOperation,
  listChatboxesOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { getGlobalOptions } from "../lib/server-config.js";

/** Validate against the operation's own schema so bad flags fail before the call. */
function validateOpInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown,
): TInput {
  const parsed = op.inputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const error = new Error(`Invalid input: ${detail}`);
    (error as { exitCode?: number }).exitCode = 2;
    throw error;
  }
  return parsed.data;
}

async function executeOp<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  input: TInput,
  options: PlatformOptions,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runPlatformCommand(
    options,
    globalOptions.timeout,
    ({ client, signal }) => op.execute(input, { client, signal }),
  );
  writeResult(result, globalOptions.format);
}

export function registerChatCommands(program: Command): void {
  const chatboxes = program
    .command("chatboxes")
    .description("Inspect the chatboxes published from a hosted project");

  addPlatformOptions(
    chatboxes
      .command("list")
      .description("List the chatboxes published from a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const input = validateOpInput(listChatboxesOperation, {
      ...(options.project === undefined ? {} : { project: options.project }),
    });
    await executeOp(listChatboxesOperation, input, options, command);
  });

  addPlatformOptions(
    chatboxes
      .command("get")
      .description(
        "Show one chatbox: access mode, attached servers, share link",
      )
      .requiredOption("--chatbox <id-or-name>", "Chatbox name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(
    async (
      options: PlatformOptions & { chatbox: string; project?: string },
      command,
    ) => {
      const input = validateOpInput(getChatboxOperation, {
        chatbox: options.chatbox,
        ...(options.project === undefined ? {} : { project: options.project }),
      });
      await executeOp(getChatboxOperation, input, options, command);
    },
  );

  const sessions = program
    .command("chat-sessions")
    .description("Inspect saved chat sessions");

  addPlatformOptions(
    sessions
      .command("list")
      .description(
        "List chat sessions, newest first (all accessible projects unless --project is given)",
      )
      .option("--project <id-or-name>", "Restrict to one project")
      .option("--status <status>", "Filter by session status")
      .option("--limit <n>", "Maximum sessions to return (1-200)", (value) =>
        Number.parseInt(value, 10),
      ),
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        status?: string;
        limit?: number;
      },
      command,
    ) => {
      const input = validateOpInput(listChatSessionsOperation, {
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      await executeOp(listChatSessionsOperation, input, options, command);
    },
  );
}
