import { Command } from "commander";
import {
  MCP_TASKS_CHECK_CATEGORIES,
  MCP_TASKS_CHECK_IDS,
  MCPTasksConformanceTest,
  type MCPTasksCheckCategory,
  type MCPTasksCheckId,
  type MCPTasksConformanceConfig,
} from "@mcpjam/sdk";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
} from "../lib/conformance-output.js";
import { parseReporterFormat } from "../lib/reporting.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addSharedServerOptions,
  describeTarget,
  parseJsonRecord,
  parsePositiveInteger,
  parseServerConfig,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError } from "../lib/output.js";

const TASKS_CHECK_IDS_BY_CATEGORY: Record<
  MCPTasksCheckCategory,
  readonly MCPTasksCheckId[]
> = {
  dispatch: ["tasks-wire-resolvable", "tasks-declaration-hygiene"],
  creation: [
    "tasks-result-type-discipline",
    "tasks-undeclared-creation-refused",
  ],
  lifecycle: [
    "tasks-ttl-shape",
    "tasks-inline-result",
    "tasks-mcp-name-routing",
    "tasks-undeclared-capability-rejected",
  ],
};

/**
 * Exit code for a finished run.
 *
 * `incomplete` gets its own code because "the server violated the spec" and
 * "we never established anything" are different failures with different fixes,
 * and a run that skipped its task-dependent checks must never look like a pass.
 * `2` is taken by usage errors, so the new state is `3`.
 *
 * The result is read structurally rather than by SDK type so an older
 * `@mcpjam/sdk` (no `outcome`) still maps cleanly through `passed`.
 */
export function tasksConformanceExitCode(result: {
  passed: boolean;
  outcome?: "passed" | "failed" | "incomplete";
}): number {
  if (result.outcome === "incomplete") return 3;
  if (result.outcome === "failed") return 1;
  return result.passed ? 0 : 1;
}

export interface TasksConformanceOptions extends SharedServerTargetOptions {
  category?: string[];
  checkId?: string[];
  toolName?: string;
  toolArgs?: string;
  pollTimeout?: number;
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowed: readonly string[]
): string[] {
  return (values ?? []).filter((value) => !allowed.includes(value));
}

export function buildTasksConformanceConfig(
  options: TasksConformanceOptions
): MCPTasksConformanceConfig {
  const serverConfig = parseServerConfig(options);

  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_TASKS_CHECK_CATEGORIES
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_TASKS_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${
        invalidCheckIds.length === 1 ? "" : "s"
      }: ${invalidCheckIds.join(", ")}`
    );
  }

  const resolvedCheckIds =
    checkIds && checkIds.length > 0
      ? checkIds
      : categories && categories.length > 0
      ? Array.from(
          new Set(
            categories.flatMap(
              (category) =>
                TASKS_CHECK_IDS_BY_CATEGORY[category as MCPTasksCheckCategory]
            )
          )
        )
      : undefined;

  return {
    ...serverConfig,
    ...(resolvedCheckIds && resolvedCheckIds.length > 0
      ? { checkIds: resolvedCheckIds as MCPTasksConformanceConfig["checkIds"] }
      : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.toolArgs
      ? { toolArguments: parseJsonRecord(options.toolArgs, "--tool-args") }
      : {}),
    ...(options.pollTimeout ? { pollTimeoutMs: options.pollTimeout } : {}),
  };
}

export function registerTasksCommands(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Validate MCP Tasks wire behavior (legacy and SEP-2663)");

  addSharedServerOptions(
    tasks
      .command("conformance")
      .description("Run MCP Tasks conformance checks")
      .option(
        "--category <category>",
        "Check category to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        []
      )
      .option(
        "--check-id <id>",
        "Specific check ID to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        []
      )
      .option(
        "--tool-name <tool>",
        "Tool used to provoke a task. Required for servers whose tools carry no task metadata (the extension wire)."
      )
      .option("--tool-args <json>", "Tool arguments as a JSON object")
      .option(
        "--poll-timeout <ms>",
        "How long to poll a created task for a terminal status",
        (value: string) => parsePositiveInteger(value, "Poll timeout"),
        30_000
      )
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml"
      )
  ).action(async (options, command) => {
    const reporter = parseReporterFormat(
      options.reporter as string | undefined
    );
    const globalOptions = command.optsWithGlobals() as {
      format?: string;
      timeout?: number;
      rpc?: boolean;
      quiet?: boolean;
    };
    const format = resolveConformanceOutputFormatForCli(
      globalOptions.format,
      process.stdout.isTTY,
      reporter
    );
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;

    const config: MCPTasksConformanceConfig = {
      ...buildTasksConformanceConfig({
        ...(options as TasksConformanceOptions),
        timeout: globalOptions.timeout ?? 30_000,
      }),
      ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
    };
    const result = await new MCPTasksConformanceTest(config).run();

    const outputResult = reporter
      ? result
      : (withRpcLogsIfRequested(result, collector, {
          format,
          rpc: globalOptions.rpc ?? false,
        }) as typeof result);
    const output = renderConformanceForCli(outputResult, reporter, format);
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

    const incompleteReason = (result as { incompleteReason?: string })
      .incompleteReason;
    if (incompleteReason && !globalOptions.quiet) {
      // The JSON payload carries it too, but a human running this in a terminal
      // must not have to dig for the reason six checks never ran.
      process.stderr.write(`Run incomplete: ${incompleteReason}\n`);
    }

    const exitCode = tasksConformanceExitCode(result);
    if (exitCode !== 0) {
      setProcessExitCode(exitCode);
    }
  });
}
