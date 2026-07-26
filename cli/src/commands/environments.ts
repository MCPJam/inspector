import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  archiveEnvironmentOperation,
  createEnvironmentOperation,
  getEnvironmentOperation,
  listEnvironmentsOperation,
  resolveEnvironmentOperation,
  restoreEnvironmentOperation,
  updateEnvironmentOperation,
  PlatformApiError,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError, writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam environments` — the Project Environment surface.
 *
 * A project environment is a named execution bundle (one host, optionally a
 * standalone server group, pinned skills, and pinned plugin versions) that eval
 * suites and journeys run against. It is NOT a Computer sandbox image — those
 * are `mcpjam images`.
 *
 * Environments are revisioned: `update`, `archive`, and `restore` all require
 * `--expected-revision`, the revision you last read with `get`. If someone else
 * changed the environment in between, the write is rejected with a conflict
 * rather than silently overwriting their edit.
 */

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
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

function validateInput<TInput>(
  op: PlatformOperation<TInput, unknown>,
  raw: unknown
): TInput {
  const parsed = op.inputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid input: ${detail}`);
  }
  return parsed.data;
}

/** Read a JSON object from --file (literal path or `-` for stdin) / --json. */
function loadJsonObject(options: {
  file?: string;
  json?: string;
}): Record<string, unknown> | undefined {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }
  let base: unknown;
  if (options.file !== undefined) {
    let text: string;
    try {
      text =
        options.file === "-"
          ? readFileSync(0, "utf8")
          : readFileSync(options.file, "utf8");
    } catch (error) {
      throw usageError(`Failed to read --file "${options.file}".`, {
        source: error instanceof Error ? error.message : String(error),
      });
    }
    if (text.trim() === "") throw usageError("--file input is empty.");
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  } else {
    return undefined;
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw usageError("Environment input must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

/**
 * Commander gives us option values as strings. The revision is a precondition,
 * not a hint, so reject anything that isn't a clean non-negative integer rather
 * than letting `NaN` reach the API as a silently-failing check.
 */
function parseRevision(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(
      "--expected-revision must be a non-negative integer (read it from `mcpjam environments get`)."
    );
  }
  return value;
}

export function registerEnvironmentsCommands(program: Command): void {
  const environments = program
    .command("environments")
    .description(
      "List, create, and manage the project environments (host + servers + pinned skills/plugins) in your hosted MCPJam projects"
    );

  addPlatformOptions(
    environments
      .command("list")
      .description("List the project environments in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--include-archived",
        "Include archived environments (needed to find one to restore)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        includeArchived?: boolean;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          listEnvironmentsOperation.execute(
            {
              project: options.project,
              ...(options.includeArchived ? { includeArchived: true } : {}),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("get")
      .description(
        "Show one environment's settings and its current revision (pass that revision to update/archive/restore)"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getEnvironmentOperation.execute(
            { project: options.project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("resolve")
      .description(
        "Preview what an environment resolves to right now: host config, closed server set, and pinned plugin versions"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; environment: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          resolveEnvironmentOperation.execute(
            { project: options.project, environment: options.environment },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("create")
      .description(
        "Create a project environment (requires project admin). Body fields may be supplied via --file/--json"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "Display name for the new environment")
      .option("--host-id <id>", "ID of the host this environment runs against")
      .option("--description <text>", "Optional description")
      .option(
        "--file <path>",
        "Environment JSON file with any of name/hostId/description/serverAttachmentId/skillSelection/pluginVersionIds (or - for stdin)"
      )
      .option("--json <json>", "Inline environment JSON (or @file, or -)")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        name?: string;
        hostId?: string;
        description?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      // Explicit flags win over the same key in the JSON body, so a scripted
      // template file can be reused with a per-run --name override.
      const body = loadJsonObject(options) ?? {};
      const input = validateInput(createEnvironmentOperation, {
        ...body,
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.hostId !== undefined ? { hostId: options.hostId } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          createEnvironmentOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("update")
      .description(
        "Edit an environment. Only the fields you pass change; use --file/--json with a null value to clear serverAttachmentId, skillSelection, or pluginVersionIds"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get`); a stale value is rejected instead of overwriting a concurrent edit"
      )
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New display name")
      .option("--host-id <id>", "New host for this environment")
      .option(
        "--description <text>",
        "New description (empty string clears it)"
      )
      .option(
        "--file <path>",
        "Environment JSON file with the fields to change (or - for stdin)"
      )
      .option("--json <json>", "Inline environment JSON (or @file, or -)")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
        name?: string;
        hostId?: string;
        description?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const body = loadJsonObject(options) ?? {};
      const input = validateInput(updateEnvironmentOperation, {
        ...body,
        ...(options.project !== undefined ? { project: options.project } : {}),
        environment: options.environment,
        expectedRevision: parseRevision(options.expectedRevision),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.hostId !== undefined ? { hostId: options.hostId } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateEnvironmentOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("archive")
      .description(
        "Archive an environment (reversible; frees its name for a new one)"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get`)"
      )
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          archiveEnvironmentOperation.execute(
            {
              project: options.project,
              environment: options.environment,
              expectedRevision: parseRevision(options.expectedRevision),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    environments
      .command("restore")
      .description(
        "Restore an archived environment. Plugin pins whose version no longer exists are dropped — check the returned pluginVersionIds"
      )
      .requiredOption("--environment <id-or-name>", "Environment name or ID")
      .requiredOption(
        "--expected-revision <n>",
        "The revision you last read (from `environments get --include-archived` via list)"
      )
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        expectedRevision: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          restoreEnvironmentOperation.execute(
            {
              project: options.project,
              environment: options.environment,
              expectedRevision: parseRevision(options.expectedRevision),
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}
