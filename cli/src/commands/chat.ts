/**
 * Read-only views of the chat sessions the published scenarios and the in-app
 * Playground produced.
 *
 * These operations shipped in the SDK and the MCP catalog but had no CLI
 * binding, which made them unreachable from a script — you could ask an agent
 * about your sessions but not `grep` them in CI. Reads only.
 *
 * The scenario reads that used to live here moved to `commands/scenarios.ts`,
 * which owns the whole `mcpjam scenarios` group.
 */
import type { Command } from "commander";
import {
  listChatSessionsOperation,
  PlatformApiError,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>,
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        },
      ),
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    // When OUR deadline fired, surface the armed TIMEOUT error rather than the
    // bare AbortError some fetch implementations reject with.
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

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
