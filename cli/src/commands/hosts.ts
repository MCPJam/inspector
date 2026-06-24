import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  createHostOperation,
  deleteHostOperation,
  getHostOperation,
  listHostsOperation,
  updateHostOperation,
  PlatformApiError,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { HOST_TEMPLATES as SDK_HOST_TEMPLATES } from "@mcpjam/sdk/host-config/templates";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError, writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

/**
 * Built-in host templates surfaced by `hosts templates`, derived from the SDK
 * registry (single source of truth) so this list can't drift from what
 * `create --template` actually accepts.
 */
const HOST_TEMPLATES: ReadonlyArray<{ id: string; label: string }> =
  SDK_HOST_TEMPLATES.map(({ id, label }) => ({ id, label }));

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
      new PlatformApiError(`Request timed out after ${timeoutMs}ms`, "TIMEOUT", {
        status: 0,
      })
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

/** Read a JSON object from --file (literal path or `-` for stdin) / --json. */
function loadConfigObject(options: {
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
    throw usageError("Host config must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

export function registerHostsCommands(program: Command): void {
  const hosts = program
    .command("hosts")
    .description("List, create, and manage the hosts in your hosted MCPJam projects");

  hosts
    .command("templates")
    .description("List the built-in host templates usable with `hosts create --template`")
    .action((_options, command) => {
      const globalOptions = getGlobalOptions(command);
      writeResult({ items: HOST_TEMPLATES }, globalOptions.format);
    });

  addPlatformOptions(
    hosts
      .command("list")
      .description("List the hosts saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
  ).action(async (options: PlatformOptions & { project?: string }, command) => {
    const globalOptions = getGlobalOptions(command);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        listHostsOperation.execute({ project: options.project }, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    hosts
      .command("get")
      .description("Show one host's full settings, including its host config")
      .requiredOption("--host <id-or-name>", "Host name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project?: string; host: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getHostOperation.execute(
            { project: options.project, host: options.host },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    hosts
      .command("create")
      .description(
        "Create a host from a built-in template (--template) or a full host config (--file/--json)"
      )
      .requiredOption("--name <name>", "Display name for the new host")
      .option("--project <id-or-name>", "Project name or ID")
      .option(
        "--template <id>",
        "Built-in template id (see `hosts templates`), e.g. claude, chatgpt, cursor"
      )
      .option(
        "--theme <theme>",
        "Theme for the seeded config: light or dark (template only)"
      )
      .option("--file <path>", "Host config v2 JSON file (or - for stdin)")
      .option("--json <json>", "Inline host config v2 JSON (or @file, or -)")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        name: string;
        template?: string;
        theme?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const config = loadConfigObject(options);
      const input = validateInput(createHostOperation, {
        project: options.project,
        name: options.name,
        ...(options.template !== undefined ? { template: options.template } : {}),
        ...(options.theme !== undefined ? { theme: options.theme } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          createHostOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    hosts
      .command("update")
      .description("Edit a host's name and/or its host config")
      .requiredOption("--host <id-or-name>", "Host name or ID")
      .option("--project <id-or-name>", "Project name or ID")
      .option("--name <name>", "New display name")
      .option("--file <path>", "Replacement host config v2 JSON (or - for stdin)")
      .option("--json <json>", "Inline replacement host config v2 JSON (or @file, or -)")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        host: string;
        name?: string;
        file?: string;
        json?: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const config = loadConfigObject(options);
      const input = validateInput(updateHostOperation, {
        project: options.project,
        host: options.host,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          updateHostOperation.execute(input, { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    hosts
      .command("delete")
      .description("Permanently delete a host from a project")
      .requiredOption("--host <id-or-name>", "Host name or ID")
      .option("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        host: string;
      },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          deleteHostOperation.execute(
            {
              project: options.project,
              host: options.host,
            },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );
}

/** Validate a merged input object against an operation's schema (usage error on failure). */
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
