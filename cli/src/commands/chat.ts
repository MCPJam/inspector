/**
 * Read-only views of the chat sessions that published scenarios and the in-app
 * Playground produced. Reads only.
 *
 * The scenario reads that used to live here moved to `commands/scenarios.ts`:
 * after the rename both files registered a top-level `scenarios` command, and
 * that group owns all four operations now.
 */
import type { Command } from "commander";
import {
  listChatSessionsOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
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
  options: PlatformOptions & { project?: string },
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runPlatformCommand(
    platformOptionsOf(command),
    globalOptions.timeout,
    ({ client, signal }) => op.execute(input, { client, signal }),
    {
      quiet: globalOptions.quiet,
      cloudScope:
        options.project !== undefined
          ? {
              kind: "project",
              selector: options.project,
              source: "flag",
            }
          : { kind: "all-projects" },
    },
  );
  writeResult(result, globalOptions.format);
}

export function registerChatCommands(program: Command): void {
  const sessions = program
    .command("chat-sessions")
    .description("Inspect saved chat sessions");

      sessions
      .command("list")
      .description(
        "List chat sessions, newest first (all accessible projects unless --project is given)",
      )
      .option("--project <id-or-name>", "Restrict to one project")
      .option("--status <status>", "Filter by session status")
      .option("--limit <n>", "Maximum sessions to return (1-200)", (value) =>
        Number.parseInt(value, 10),
      )
      .action(
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
