/**
 * `mcpjam cloud sessions` — find a conversation, or list Playground chat
 * sessions.
 *
 * `search` spans every surface (Playground, user testing, evals, swarms).
 * `list` is the older Playground-only listing (`chat-sessions list`): all
 * accessible projects unless `--project` is given. Ambient `.mcpjam/project.json`
 * does not narrow `list`; that stays an explicit flag until the shared
 * project-selection rule lands.
 */
import type { Command } from "commander";
import {
  listChatSessionsOperation,
  searchSessionsOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions } from "../lib/server-config.js";

type SearchOptions = PlatformOptions & {
  project?: string;
  query?: string;
  scope?: string;
  source?: string;
  status?: string;
  limit?: string;
  cursor?: string;
};

function requireQuery(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw usageError("--query needs search terms.");
  }
  return trimmed;
}

function parseSources(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parsed.length === 0) {
    throw usageError(
      "--source was given but names no surfaces. Pass a comma-separated list (direct, scenario, eval, swarm), or omit the flag to search all of them."
    );
  }
  return parsed;
}

function validateOpInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown
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

export function registerSessionsCommands(program: Command): void {
  const sessions = program
    .command("sessions")
    .description(
      "List Playground chat sessions, or search conversations across Playground, user testing, evals and swarms."
    );

  sessions
    .command("list")
    .description(
      "List Playground chat sessions, newest first (all accessible projects unless --project is given)"
    )
    .option("--project <id-or-name>", "Restrict to one project")
    .option("--status <status>", "Filter by session status")
    .option("--limit <n>", "Maximum sessions to return (1-200)", (value) =>
      Number.parseInt(value, 10)
    )
    .action(
      async (
        options: PlatformOptions & {
          project?: string;
          status?: string;
          limit?: number;
        },
        command
      ) => {
        const input = validateOpInput(listChatSessionsOperation, {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        });
        const globalOptions = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            listChatSessionsOperation.execute(input, { client, signal }),
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
          }
        );
        writeResult(result, globalOptions.format);
      }
    );

  bindOperation(
    addProjectOption(
      sessions
        .command("search")
        .description(
          "Search a project's sessions by relevance. Searches titles and opening messages by default; pass --scope transcripts to search what was actually said inside the conversations. Every result carries a link you can open."
        )
        .requiredOption("--query <text>", "Search terms")
        .option(
          "--scope <scope>",
          "titles (default) or transcripts. Transcript search excludes sessions created before 2026-08-14."
        )
        .option(
          "--source <types>",
          "Comma-separated surfaces: direct, scenario, eval, swarm. Defaults to all."
        )
        .option("--status <status>", "active (default) or archived")
        .option("--limit <n>", "Results per page (1-200)")
        .option(
          "--cursor <cursor>",
          "Opaque cursor from a previous page's nextCursor. Page with the same --query and --scope you started with."
        )
    ),
    searchSessionsOperation,
    (options: SearchOptions) => ({
      query: requireQuery(options.query),
      project: options.project,
      scope: options.scope as "titles" | "transcripts" | undefined,
      sourceTypes: parseSources(options.source) as
        | ("direct" | "scenario" | "eval" | "swarm")[]
        | undefined,
      status: options.status as "active" | "archived" | undefined,
      limit: parseIntegerOption(options.limit, "--limit", {
        min: 1,
        max: 200,
      }),
      cursor: options.cursor,
    })
  );
}
