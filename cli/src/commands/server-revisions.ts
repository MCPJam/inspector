import type { Command } from "commander";
import {
  diffServerRevisionsOperation,
  getServerRevisionOperation,
  listServerRevisionsOperation,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";

type RevisionOptions = PlatformOptions & {
  project?: string;
  server: string;
  limit?: string;
  cursor?: string;
  revision: string;
  from?: string;
};

/**
 * A saved server's stored revisions, read without connecting to it. Three
 * sibling commands rather than a `revisions` group with subcommands, so
 * `--server` stays a required option on the command that runs.
 */
export function registerServerRevisionCommands(servers: Command): void {
  bindOperation(
    addProjectOption(
      servers
        .command("revisions")
        .description(
          "List a saved server's stored revisions, newest first: captures of its tools and server info",
        )
        .requiredOption("--server <id-or-name>", "Server ID or name")
        .option("--limit <n>", "Revisions per page, 1 to 200 (default 50)")
        .option("--cursor <cursor>", "nextCursor from the previous page"),
    ),
    listServerRevisionsOperation,
    (options: RevisionOptions) => ({
      project: options.project,
      server: options.server,
      limit: parseIntegerOption(options.limit, "--limit", { min: 1, max: 200 }),
      cursor: options.cursor,
    }),
  );

  bindOperation(
    addProjectOption(
      servers
        .command("revision")
        .description(
          "Read one stored revision of a saved server: its tools and server info",
        )
        .requiredOption("--server <id-or-name>", "Server ID or name")
        .requiredOption("--revision <number>", "Revision number"),
    ),
    getServerRevisionOperation,
    (options: RevisionOptions) => ({
      project: options.project,
      server: options.server,
      revisionNumber: parseRequiredIntegerOption(
        options.revision,
        "--revision",
        { min: 1 },
      ),
    }),
  );

  bindOperation(
    addProjectOption(
      servers
        .command("revision-diff")
        .description(
          "Compare two stored revisions of a saved server: tools added, removed and changed, and server info changes",
        )
        .requiredOption("--server <id-or-name>", "Server ID or name")
        .requiredOption("--revision <number>", "The later revision")
        .option(
          "--from <number>",
          "The revision to compare against (default: the one before)",
        ),
    ),
    diffServerRevisionsOperation,
    (options: RevisionOptions) => ({
      project: options.project,
      server: options.server,
      revisionNumber: parseRequiredIntegerOption(
        options.revision,
        "--revision",
        { min: 1 },
      ),
      fromRevisionNumber: parseIntegerOption(options.from, "--from", {
        min: 1,
      }),
    }),
  );
}
