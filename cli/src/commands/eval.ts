import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  createEvalCaseOperation,
  createEvalSuiteOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuitesOperation,
  PlatformApiError,
  runEvalSuiteOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  type CreateEvalSuiteInput,
  type PlatformOperation,
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

/** Read a partial JSON body object from --file / --json (or {} when absent). */
function loadBodyObject(options: {
  file?: string;
  json?: string;
}): Record<string, unknown> {
  if (options.file !== undefined && options.json !== undefined) {
    throw usageError("Provide either --file or --json, not both.");
  }
  let base: unknown = {};
  if (options.file !== undefined) {
    const text = readFileOrStdin(options.file, "--file");
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
  }
  if (base === undefined || base === null) base = {};
  if (typeof base !== "object" || Array.isArray(base)) {
    throw usageError("Body must be a JSON object.");
  }
  return base as Record<string, unknown>;
}

/** Validate a merged input object against an operation's schema (usage error on failure). */
function validateOpInput<TInput>(
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

/** Run an operation with a pre-validated input and print the result. */
async function executeOp<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  input: TInput,
  options: PlatformOptions,
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runPlatformCommand(
    options,
    globalOptions.timeout,
    ({ client, signal }) => op.execute(input, { client, signal })
  );
  writeResult(result, globalOptions.format);
}

/** Merge `eval update` flags onto an optional --file/--json suite-update body. */
function buildSuiteUpdateInput(
  options: Record<string, any>
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  input.suite = options.suite;
  if (options.project !== undefined) input.project = options.project;
  if (options.name !== undefined) input.name = options.name;
  if (options.description !== undefined)
    input.description = options.description;
  if (options.server !== undefined)
    input.environment = {
      ...(input.environment ?? {}),
      servers: options.server,
    };
  if (options.host !== undefined)
    input.hosts = options.host.map((host: string) => ({ host }));

  const exec = { ...(input.executionConfig ?? {}) };
  if (options.model !== undefined) exec.model = options.model;
  if (options.systemPrompt !== undefined)
    exec.systemPrompt = options.systemPrompt;
  if (options.temperature !== undefined)
    exec.temperature = Number(options.temperature);
  if (Object.keys(exec).length > 0) input.executionConfig = exec;

  const settings = { ...(input.settings ?? {}) };
  if (options.minAccuracy !== undefined)
    settings.minimumAccuracy = Number(options.minAccuracy);
  const mo = { ...(settings.matchOptions ?? {}) };
  if (options.toolCallOrder !== undefined)
    mo.toolCallOrder = options.toolCallOrder;
  if (options.arguments !== undefined) mo.arguments = options.arguments;
  if (options.extraToolCalls !== undefined)
    mo.extraToolCalls =
      options.extraToolCalls === "unlimited"
        ? "unlimited"
        : Number(options.extraToolCalls);
  if (Object.keys(mo).length > 0) settings.matchOptions = mo;
  const judge = { ...(settings.judge ?? {}) };
  if (options.judge !== undefined) {
    if (options.judge !== "on" && options.judge !== "off") {
      throw usageError('--judge must be "on" or "off".');
    }
    judge.enabled = options.judge === "on";
  }
  if (options.judgeModel !== undefined) judge.model = options.judgeModel;
  if (Object.keys(judge).length > 0) settings.judge = judge;
  if (Object.keys(settings).length > 0) input.settings = settings;

  return input;
}

/** Merge a --file/--json case body with the selectors (+ optional --title). */
function buildCaseInput(
  options: Record<string, any>,
  opts: { requireCase: boolean }
): Record<string, unknown> {
  const input: Record<string, any> = { ...loadBodyObject(options) };
  if (options.project !== undefined) input.project = options.project;
  input.suite = options.suite;
  if (opts.requireCase) input.case = options.case;
  if (options.title !== undefined) input.title = options.title;
  return input;
}

export function registerEvalCommands(program: Command): void {
  const evals = program
    .command("eval")
    .description("Author and run eval suites in your hosted MCPJam projects");

  addPlatformOptions(
    evals
      .command("create")
      .description(
        "Create a runnable eval suite from authored test cases (does not run it)"
      )
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--file <path>",
        "Path to a suite definition JSON file (or - for stdin)"
      )
      .option(
        "--json <json>",
        "Inline suite definition JSON (or @file, or - for stdin)"
      )
      .option("--name <name>", "Suite name (overrides the file)")
      .option(
        "--model <model>",
        "Suite-level default model (overrides the file)"
      )
      .option(
        "--provider <provider>",
        "Suite-level default provider (overrides the file; needed for bare/custom model ids)"
      )
      .option(
        "--server <name...>",
        "Project HTTP server names or IDs (overrides the file)"
      )
  ).action(async (options: CreateOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const input = loadSuiteDefinition(options);
    const result = await runPlatformCommand(
      options,
      globalOptions.timeout,
      ({ client, signal }) =>
        createEvalSuiteOperation.execute(input, { client, signal })
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    evals
      .command("list")
      .description("List the eval suites saved in a project")
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
        listEvalSuitesOperation.execute(
          { project: options.project },
          { client, signal }
        )
    );
    writeResult(result, globalOptions.format);
  });

  addPlatformOptions(
    evals
      .command("run")
      .description("Start an eval run of an existing suite (asynchronous)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option(
        "--project <id-or-name>",
        "Project name or ID (defaults to the most recently updated project)"
      )
      .option(
        "--server <name...>",
        "Override the suite's saved server selection (HTTP servers only)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        server?: string[];
      },
      command
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
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  addPlatformOptions(
    evals
      .command("status")
      .description("Get the status and summary of an eval run")
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption("--project <id-or-name>", "Project name or ID")
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command
    ) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          getEvalRunOperation.execute(
            { project: options.project, runId: options.run },
            { client, signal }
          )
      );
      writeResult(result, globalOptions.format);
    }
  );

  const PROJECT_OPT = "Project name or ID (defaults to most recently updated)";

  // ── Eval run iterations + traces ───────────────────────────────────
  addPlatformOptions(
    evals
      .command("iterations")
      .description(
        "List per-iteration results for an eval run (pass/fail, tool calls, tokens, latency)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
      .option("--cursor <cursor>", "Pagination cursor from a previous response")
      .option("--limit <n>", "Max iterations per page (1–200)")
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        cursor?: string;
        limit?: string;
      },
      command
    ) => {
      const input = validateOpInput(listEvalRunIterationsOperation, {
        project: options.project,
        runId: options.run,
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}),
      });
      await executeOp(listEvalRunIterationsOperation, input, options, command);
    }
  );

  addPlatformOptions(
    evals
      .command("trace")
      .description(
        "Fetch the full trace for one eval iteration (large: full message history + spans)"
      )
      .requiredOption("--run <id>", "Eval run ID (from `eval run`)")
      .requiredOption(
        "--iteration <id>",
        "Iteration ID (from `eval iterations`)"
      )
      .requiredOption(
        "--project <id-or-name>",
        "Project the run belongs to (name or ID)"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        run: string;
        iteration: string;
      },
      command
    ) => {
      await executeOp(
        getEvalIterationTraceOperation,
        {
          project: options.project,
          runId: options.run,
          iterationId: options.iteration,
        },
        options,
        command
      );
    }
  );

  // ── Suite settings: get / update / delete / schedule ───────────────
  addPlatformOptions(
    evals
      .command("get")
      .description("Show an eval suite's full settings")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        getEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("update")
      .description(
        "Edit an eval suite's settings (only the flags you pass change)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Suite-update JSON body (or - for stdin)")
      .option("--json <json>", "Inline suite-update JSON (or @file, or -)")
      .option("--name <name>", "Rename the suite")
      .option("--description <text>", "Suite description")
      .option(
        "--server <name...>",
        "Replace the suite's server selection (project server names)"
      )
      .option("--host <name...>", "Replace host attachments (by name/ID)")
      .option("--model <id>", "Execution model id")
      .option("--system-prompt <text>", "Execution system prompt")
      .option("--temperature <n>", "Execution temperature")
      .option("--min-accuracy <pct>", "Minimum accuracy, 0–100")
      .option("--tool-call-order <any|in-order|exact>", "Tool call order")
      .option("--arguments <ignore|partial|exact>", "Argument matching")
      .option("--extra-tool-calls <unlimited|N>", "Allowed extra tool calls")
      .option("--judge <on|off>", "Enable/disable LLM-as-judge grading")
      .option("--judge-model <id>", "Judge model id")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalSuiteOperation,
      buildSuiteUpdateInput(options)
    );
    await executeOp(updateEvalSuiteOperation, input, options, command);
  });

  addPlatformOptions(
    evals
      .command("delete")
      .description("Permanently delete an eval suite (and its cases and runs)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        deleteEvalSuiteOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    evals
      .command("schedule")
      .description("Enable or disable scheduled runs for a suite")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--enable", "Enable scheduled runs")
      .option("--disable", "Disable scheduled runs")
      .option("--interval <minutes>", "Run interval in minutes (5–10080)")
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        enable?: boolean;
        disable?: boolean;
        interval?: string;
      },
      command
    ) => {
      if (options.enable && options.disable) {
        throw usageError("Pass either --enable or --disable, not both.");
      }
      if (!options.enable && !options.disable) {
        throw usageError("Pass --enable or --disable.");
      }
      const input = validateOpInput(setEvalSuiteScheduleOperation, {
        project: options.project,
        suite: options.suite,
        enabled: Boolean(options.enable),
        ...(options.interval !== undefined
          ? { intervalMinutes: Number(options.interval) }
          : {}),
      });
      await executeOp(setEvalSuiteScheduleOperation, input, options, command);
    }
  );

  // ── Case CRUD + generate ───────────────────────────────────────────
  const cases = evals
    .command("cases")
    .description("List, author, and edit an eval suite's test cases");

  addPlatformOptions(
    cases
      .command("list")
      .description("List a suite's test cases")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & { project?: string; suite: string },
      command
    ) => {
      await executeOp(
        listEvalCasesOperation,
        { project: options.project, suite: options.suite },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("get")
      .description("Show one test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        getEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("create")
      .description("Add a test case to a suite (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Case title (overrides the body)")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      createEvalCaseOperation,
      buildCaseInput(options, { requireCase: false })
    );
    await executeOp(createEvalCaseOperation, input, options, command);
  });

  addPlatformOptions(
    cases
      .command("update")
      .description("Edit a test case (definition via --file/--json)")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--file <path>", "Case JSON body (or - for stdin)")
      .option("--json <json>", "Inline case JSON (or @file, or -)")
      .option("--title <title>", "Rename the case")
  ).action(async (options: PlatformOptions & Record<string, any>, command) => {
    const input = validateOpInput(
      updateEvalCaseOperation,
      buildCaseInput(options, { requireCase: true })
    );
    await executeOp(updateEvalCaseOperation, input, options, command);
  });

  addPlatformOptions(
    cases
      .command("delete")
      .description("Permanently delete a test case")
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .requiredOption("--case <id-or-title>", "Eval case title or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        case: string;
      },
      command
    ) => {
      await executeOp(
        deleteEvalCaseOperation,
        { project: options.project, suite: options.suite, case: options.case },
        options,
        command
      );
    }
  );

  addPlatformOptions(
    cases
      .command("generate")
      .description(
        "AI-generate test cases from the suite's tools (spends credits)"
      )
      .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
      .option("--project <id-or-name>", PROJECT_OPT)
      .option("--mode <normal|negative>", "Generation mode (default normal)")
      .option(
        "--server <name...>",
        "Servers to discover tools from (default: suite's)"
      )
      .option(
        "--case-model <id...>",
        "Execution model(s) for the generated cases"
      )
      .option("--simple <n>", "How many easy, single-tool cases")
      .option("--multi-tool <n>", "How many medium, 2+ tool cases")
      .option("--multi-turn <n>", "How many multi-turn follow-up cases")
      .option("--complex <n>", "How many hard / cross-server cases")
      .option("--negative <n>", "How many negative (no-tool) cases")
      .option(
        "--vary-user-styles",
        "Vary query phrasing across a realistic range of user styles"
      )
  ).action(
    async (
      options: PlatformOptions & {
        project?: string;
        suite: string;
        mode?: string;
        server?: string[];
        caseModel?: string[];
        simple?: string;
        multiTool?: string;
        multiTurn?: string;
        complex?: string;
        negative?: string;
        varyUserStyles?: boolean;
      },
      command
    ) => {
      const caseMix: Record<string, number> = {};
      for (const key of [
        "simple",
        "multiTool",
        "multiTurn",
        "complex",
        "negative",
      ] as const) {
        const raw = options[key];
        if (raw !== undefined) {
          // Number() (not parseInt) so partial junk like "2abc" is rejected
          // rather than silently truncated to 2.
          const parsed = Number(raw);
          if (!Number.isInteger(parsed)) {
            const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
            throw usageError(
              `--${flag} requires an integer value, got "${raw}".`
            );
          }
          caseMix[key] = parsed;
        }
      }
      const input = validateOpInput(generateEvalCasesOperation, {
        project: options.project,
        suite: options.suite,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.server ? { servers: options.server } : {}),
        ...(options.caseModel
          ? { caseModels: options.caseModel.map((model) => ({ model })) }
          : {}),
        ...(Object.keys(caseMix).length > 0 ? { caseMix } : {}),
        ...(options.varyUserStyles ? { varyUserStyles: true } : {}),
      });
      await executeOp(generateEvalCasesOperation, input, options, command);
    }
  );
}
