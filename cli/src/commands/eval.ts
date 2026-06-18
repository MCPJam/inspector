import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  createEvalSuiteOperation,
  getEvalRunOperation,
  listEvalSuitesOperation,
  PlatformApiError,
  runEvalSuiteOperation,
  type CreateEvalSuiteInput,
} from "@mcpjam/sdk/platform";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError, writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions } from "../lib/server-config.js";

type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

type CreateOptions = PlatformOptions & {
  project?: string;
  file?: string;
  json?: string;
  name?: string;
  model?: string;
  provider?: string;
  server?: string[];
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
      new PlatformApiError(`Request timed out after ${timeoutMs}ms`, "TIMEOUT", {
        status: 0,
      }),
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

/**
 * Read a suite definition file by literal path (or `-` for stdin). Unlike the
 * `@file` convention in json-input.ts, `--file` points at a real path — the
 * common affordance for a JSON document on disk.
 */
function readFileOrStdin(value: string, label: string): string {
  try {
    return value === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(value, "utf8");
  } catch (error) {
    throw usageError(`Failed to read ${label} "${value}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the create_eval_suite input from a JSON suite definition (via --file
 * or --json) plus scalar flag overrides, then validate it against the
 * operation's own schema so errors surface as usage errors before any network
 * call.
 */
function loadSuiteDefinition(options: CreateOptions): CreateEvalSuiteInput {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }

  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
    if (text.trim() === "") {
      throw usageError("--file input is empty.");
    }
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw usageError("--file must contain valid JSON.", {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (options.json !== undefined) {
    base = new JsonInputContext().parseJsonInputRecord(options.json, "--json");
  }

  if (base === undefined || base === null) {
    base = {};
  }
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Suite definition must be a JSON object.");
  }

  const merged = {
    ...(base as Record<string, unknown>),
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.server !== undefined ? { servers: options.server } : {}),
  };

  const parsed = createEvalSuiteOperation.inputSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw usageError(`Invalid suite definition: ${detail}`);
  }
  return parsed.data;
}

export function registerEvalCommands(program: Command): void {
  const evals = program
    .command("eval")
    .description("Author and run eval suites in your hosted MCPJam projects");

  addPlatformOptions(
    evals
      .command("create")
      .description(
        "Create a runnable eval suite from authored test cases (does not run it)",
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      )
      .option(
        "--file <path>",
        "Path to a suite definition JSON file (or - for stdin)",
      )
      .option(
        "--json <json>",
        "Inline suite definition JSON (or @file, or - for stdin)",
      )
      .option("--name <name>", "Suite name (overrides the file)")
      .option("--model <model>", "Suite-level default model (overrides the file)")
      .option(
        "--provider <provider>",
        "Suite-level default provider (overrides the file; needed for bare/custom model ids)",
      )
      .option(
        "--server <name...>",
        "Project HTTP server names or IDs (overrides the file)",
      ),
  ).action(async (options: CreateOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = loadSuiteDefinition(options);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        createEvalSuiteOperation.execute(input, { client, signal }),
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    evals
      .command("list")
      .description("List the eval suites saved in a project")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      ),
  ).action(
    async (options: PlatformOptions & { project?: string }, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          listEvalSuitesOperation.execute(
            { project: options.project },
            { client, signal },
          ),
      );
      writeResult(result, globalOptions.format);
    },
  );

  addPlatformOptions(
    evals
      .command("run")
      .description("Start an eval run of an existing suite (asynchronous)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)",
      )
      .option(
        "--server <name...>",
        "Override the suite's saved server selection (HTTP servers only)",
      ),
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        server?: string[];
      },
      command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          runEvalSuiteOperation.execute(
            {
              project: options.project,
              suite: options.suite,
              ...(options.server ? { servers: options.server } : {}),
            },
            { client, signal },
          ),
      );
      writeResult(result, globalOptions.format);
    },
  );

  addPlatformOptions(
    evals
      .command("status")
      .description("Get the status and summary of an eval run")
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption("--project <id-or-name>", "Project name or ID"),
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command,
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalRunOperation.execute(
            { project: options.project, runId: options.run },
            { client, signal },
          ),
      );
      writeResult(result, globalOptions.format);
    },
  );
}
