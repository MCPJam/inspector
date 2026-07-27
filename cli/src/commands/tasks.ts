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

    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
}
