/**
 * `mcpjam sessions` — find a conversation across every surface.
 *
 * A group with one subcommand today (`search`), and a group rather than a
 * top-level `mcpjam search-sessions` because the noun is the thing being
 * scripted: `sessions get` and `sessions export` are the obvious neighbours,
 * and moving a shipped top-level command under a group later is a breaking
 * rename.
 *
 * SEARCH-ONLY, deliberately: there is no `sessions list`. A project's whole
 * session history is not a useful thing to page from a terminal, and the
 * older `mcpjam chat-sessions list` already covers the Playground-only case
 * that people actually script against. What has no other answer is "which
 * session was the one where…", which is what this is.
 */
import type { Command } from "commander";
import { searchSessionsOperation } from "@mcpjam/sdk/platform";
import {
  addPlatformOptions,
  addProjectOption,
  bindOperation,
  parseIntegerOption,
} from "../lib/platform-command.js";

type SearchOptions = {
  project?: string;
  query?: string;
  scope?: string;
  source?: string;
  status?: string;
  limit?: string;
  cursor?: string;
};

/**
 * `--source` is comma-separated on the command line and an array on the wire.
 * Undefined (not `[]`) when absent: an empty array would be a request to
 * search nothing, and the operation schema rejects it — correctly, because the
 * two must never be confused.
 */
function parseSources(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

export function registerSessionsCommands(program: Command): void {
  const sessions = program
    .command("sessions")
    .description(
      "Search the conversations recorded in a project — Playground, user testing, evals and swarms in one place."
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
          "Comma-separated surfaces: direct, chatbox, eval, swarm. Defaults to all."
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
      query: options.query ?? "",
      project: options.project,
      // Passed through unvalidated: the operation's schema owns the vocabulary
      // for these, and re-listing the allowed values here would be a second
      // place to update when one is added.
      scope: options.scope as "titles" | "transcripts" | undefined,
      sourceTypes: parseSources(options.source) as
        | ("direct" | "chatbox" | "eval" | "swarm")[]
        | undefined,
      status: options.status as "active" | "archived" | undefined,
      limit: parseIntegerOption(options.limit, "--limit", {
        min: 1,
        max: 200,
      }),
      cursor: options.cursor,
    })
  );

  // Keep the group itself runnable-with-help rather than erroring bare.
  addPlatformOptions(sessions);
}
