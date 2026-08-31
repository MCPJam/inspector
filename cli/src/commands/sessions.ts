/**
 * `mcpjam cloud sessions` — find a conversation, or list Playground chat
 * sessions.
 *
 * `search` spans every surface (Playground, user testing, evals, swarms).
 * `list` is the older Playground-only listing (`chat-sessions list`). It uses
 * the shared project-selection rule; pass `--all-projects` to list across
 * every accessible project (the previous default).
 *
 * `send`/`show`/`trace` are the agent Playground loop: send a message, read
 * the raw messages, read the per-turn spans. `send` SPENDS model credits and
 * takes a REQUIRED `--idempotency-key` — stable per intent, not per attempt,
 * so a retried invocation replays the completed turn instead of paying twice.
 */
import { Option, type Command } from "commander";
import {
  getChatSessionOperation,
  getChatSessionTraceOperation,
  listChatSessionsOperation,
  resolveProject,
  searchSessionsOperation,
  sendChatMessageOperation,
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

  // ── Agent Playground ──────────────────────────────────────────────────────

  bindOperation(
    addProjectOption(
      sessions
        .command("send")
        .description(
          "Send one message to a project's MCP servers and print the reply plus the raw tool calls, latency and token usage. SPENDS model credits. Omit --session to start a conversation; pass the sessionId it returns to continue one."
        )
        .requiredOption("--message <text>", "The message to send, as the user")
        .requiredOption(
          "--idempotency-key <key>",
          "Stable key for THIS turn's intent. Reuse it when retrying: a retry with the same key replays the completed turn instead of running and billing it again. Do NOT generate a fresh key per attempt."
        )
        .option(
          "--session <sessionId>",
          "Continue this session instead of starting one. Configuration is fixed at the first turn, so the flags below are refused with a session."
        )
        .option(
          "--model <modelId>",
          'Provider-prefixed model id, e.g. "anthropic/claude-sonnet-5". Required to start a session; a bare id is rejected rather than guessed.'
        )
        .option(
          "--environment <environmentId>",
          "Run against this environment's servers (mutually exclusive with --server)"
        )
        .option(
          "--server <serverId...>",
          "Run against these project servers (mutually exclusive with --environment)"
        )
        .option("--system-prompt <text>", "System prompt for the session")
        .option(
          "--tool-mode <mode>",
          "read_only (default) advertises only tools annotated readOnlyHint:true. auto advertises everything and MAY CAUSE REAL SIDE EFFECTS."
        )
        .option("--max-steps <n>", "Maximum engine steps this turn (1-16)")
        .option(
          "--max-tool-calls <n>",
          "Cap the tool calls this turn may make. 0 answers without tools."
        )
        .option("--temperature <n>", "Sampling temperature (0-2)")
    ),
    sendChatMessageOperation,
    (options: SendOptions) => ({
      idempotencyKey: options.idempotencyKey ?? "",
      message: options.message ?? "",
      project: options.project,
      sessionId: options.session,
      modelId: options.model,
      environmentId: options.environment,
      serverIds: options.server,
      systemPrompt: options.systemPrompt,
      toolMode: options.toolMode as "read_only" | "auto" | undefined,
      maxSteps: parseIntegerOption(options.maxSteps, "--max-steps", {
        min: 1,
        max: 16,
      }),
      maxToolCalls: parseIntegerOption(
        options.maxToolCalls,
        "--max-tool-calls",
        { min: 0, max: 16 }
      ),
      temperature: parseFloatOption(options.temperature),
    }),
    // A Playground turn runs a model, and often tools with it. The 30s program
    // default expired mid-turn while the turn kept running and spending, which
    // reads to the caller as "it failed" when it had not.
    { defaultTimeoutMs: 300_000 }
  );

  bindOperation(
    addProjectOption(
      sessions
        .command("show")
        .description(
          "Print a session's metadata and a window of its raw messages. Message indices are ABSOLUTE transcript positions — the same ones `sessions trace` spans reference."
        )
        .requiredOption("--session <sessionId>", "The session to read")
        .option(
          "--after-message <index>",
          "Start the window at this absolute transcript index"
        )
        .option("--limit <n>", "Messages to return (1-200)")
    ),
    getChatSessionOperation,
    (options: ShowOptions) => ({
      sessionId: options.session ?? "",
      project: options.project,
      afterMessageIndex: parseIntegerOption(
        options.afterMessage,
        "--after-message",
        { min: 0 }
      ),
      limit: parseIntegerOption(options.limit, "--limit", { min: 1, max: 200 }),
    })
  );

  bindOperation(
    addProjectOption(
      sessions
        .command("trace")
        .description(
          "Print a session's per-turn execution spans: per-tool-call latency, token usage, and indices into the transcript. Returns the LATEST turn by default — page older turns with --after-turn, or use --no-spans for cheap summaries."
        )
        .requiredOption("--session <sessionId>", "The session to trace")
        .option("--turn <turnId>", "Return exactly this turn")
        .option(
          "--after-turn <promptIndex>",
          "Page forward from this turn index (mutually exclusive with --turn)"
        )
        .option("--limit <n>", "Turns to return (1-20). Defaults to 1.")
        .option("--no-spans", "Return per-turn summaries without span payloads")
    ),
    getChatSessionTraceOperation,
    (options: TraceOptions) => ({
      sessionId: options.session ?? "",
      project: options.project,
      turnId: options.turn,
      afterPromptIndex: parseIntegerOption(options.afterTurn, "--after-turn", {
        min: 0,
      }),
      limit: parseIntegerOption(options.limit, "--limit", { min: 1, max: 20 }),
      // Commander's `--no-spans` sets `spans: false` and leaves it `true` when
      // absent, so only an explicit opt-out is forwarded — the route's own
      // default stays the source of truth for everyone else.
      includeSpans: options.spans === false ? false : undefined,
    })
  );
}

type SendOptions = PlatformOptions & {
  project?: string;
  message?: string;
  idempotencyKey?: string;
  session?: string;
  model?: string;
  environment?: string;
  server?: string[];
  systemPrompt?: string;
  toolMode?: string;
  maxSteps?: string;
  maxToolCalls?: string;
  temperature?: string;
};

type ShowOptions = PlatformOptions & {
  project?: string;
  session?: string;
  afterMessage?: string;
  limit?: string;
};

type TraceOptions = PlatformOptions & {
  project?: string;
  session?: string;
  turn?: string;
  afterTurn?: string;
  limit?: string;
  spans?: boolean;
};

/** Parse a float option, refusing a non-numeric value rather than dropping it. */
function parseFloatOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Rejected BEFORE `Number`, which maps "" and "   " to 0 — so an empty flag
  // would silently pin the session to a temperature of zero rather than
  // telling the caller their value was missing.
  if (value.trim() === "") {
    throw usageError("--temperature needs a number.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw usageError("--temperature must be a number.");
  }
  return parsed;
}

