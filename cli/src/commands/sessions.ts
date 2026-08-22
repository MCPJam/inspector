/**
 * `mcpjam cloud sessions` — find a conversation, or list Playground chat
 * sessions.
 *
 * `search` spans every surface (Playground, user testing, evals, swarms).
 * `list` is the older Playground-only listing (`chat-sessions list`). It uses
 * the shared project-selection rule; pass `--all-projects` to list across
 * every accessible project (the previous default).
 */
import { Option, type Command } from "commander";
import {
  listChatSessionsOperation,
  resolveProject,
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
import {
  appendProjectLinkHint,
  resolveCloudProjectArgs,
} from "../lib/cloud-scope.js";
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

  addProjectOption(
    sessions
      .command("list")
      .description(
        "List Playground chat sessions, newest first (one project; pass --all-projects to include every accessible project)"
      )
  )
    .addOption(
      new Option(
        "--all-projects",
        "List sessions across every accessible project, ignoring the project link and MCPJAM_PROJECT"
      ).conflicts("project")
    )
    .option("--status <status>", "Filter by session status")
    .option("--limit <n>", "Maximum sessions to return (1-200)", (value) =>
      Number.parseInt(value, 10)
    )
    .action(
      async (
        options: PlatformOptions & {
          project?: string;
          allProjects?: boolean;
          status?: string;
          limit?: number;
        },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        if (options.allProjects) {
          const input = validateOpInput(listChatSessionsOperation, {
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          });
          const result = await runPlatformCommand(
            platformOptionsOf(command),
            globalOptions.timeout,
            ({ client, signal }) =>
              listChatSessionsOperation.execute(input, { client, signal }),
            {
              quiet: globalOptions.quiet,
              cloudScope: { kind: "all-projects" },
            }
          );
          writeResult(result, globalOptions.format);
          return;
        }

        const resolved = resolveCloudProjectArgs(options);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          async ({ client, signal }) => {
            let project = resolved.project;
            if (project === undefined) {
              const page = await client.listProjects({}, { signal });
              const resolution = resolveProject(page.items, undefined);
              if (!resolution.ok) {
                throw usageError(
                  appendProjectLinkHint(
                    resolution.message,
                    resolved.projectScope
                  )
                );
              }
              project = resolution.project.id;
            }
            const input = validateOpInput(listChatSessionsOperation, {
              project,
              ...(options.status === undefined
                ? {}
                : { status: options.status }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            });
            return listChatSessionsOperation.execute(input, {
              client,
              signal,
            });
          },
          {
            quiet: globalOptions.quiet,
            projectScope: resolved.projectScope,
            cloudScope: resolved.projectScope,
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
