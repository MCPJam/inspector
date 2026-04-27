import { Command } from "commander";
import {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceSuite,
  MCPAppsConformanceTest,
  type MCPAppsCheckCategory,
  type MCPAppsCheckId,
  type MCPAppsConformanceConfig,
} from "@mcpjam/sdk";
import { loadAppsSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { parseReporterFormat, type ReporterFormat } from "../lib/reporting.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addSharedServerOptions,
  describeTarget,
  parseServerConfig,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError } from "../lib/output.js";

const APPS_CHECK_IDS_BY_CATEGORY: Record<
  MCPAppsCheckCategory,
  readonly MCPAppsCheckId[]
> = {
  tools: [
    "ui-tools-present",
    "ui-tool-metadata-valid",
    "ui-tool-input-schema-valid",
  ],
  resources: [
    "ui-listed-resources-valid",
    "ui-resources-readable",
    "ui-resource-contents-valid",
    "ui-resource-meta-valid",
  ],
};

export interface AppsConformanceOptions extends SharedServerTargetOptions {
  category?: string[];
  checkId?: string[];
}

function getConformanceGlobals(command: Command, reporter?: ReporterFormat): {
  format: ConformanceOutputFormat;
  timeout: number;
  rpc: boolean;
  quiet: boolean;
} {
  const globalOptions = command.optsWithGlobals() as {
    format?: string;
    timeout?: number;
    rpc?: boolean;
    quiet?: boolean;
  };

  return {
    format: resolveConformanceOutputFormatForCli(
      globalOptions.format,
      process.stdout.isTTY,
      reporter,
    ),
    timeout: globalOptions.timeout ?? 30_000,
    rpc: globalOptions.rpc ?? false,
    quiet: globalOptions.quiet ?? false,
  };
}

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerAppsCommands(program: Command): void {
  const apps = program
    .command("apps")
    .description("Validate MCP Apps metadata and resource wiring");

  addSharedServerOptions(
    apps
      .command("conformance")
      .description("Run MCP Apps server conformance checks")
      .option(
        "--category <category>",
        "Check category to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--check-id <id>",
        "Specific check ID to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml",
      ),
  ).action(async (options, command) => {
    const reporter = parseReporterFormat(options.reporter as string | undefined);
    const globalOptions = getConformanceGlobals(command, reporter);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config: MCPAppsConformanceConfig = {
      ...buildAppsConformanceConfig({
        ...(options as AppsConformanceOptions),
        timeout: globalOptions.timeout,
      }),
      ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
    };
    const result = await new MCPAppsConformanceTest(config).run();

    const outputResult = reporter
      ? result
      : (withRpcLogsIfRequested(
          result,
          collector,
          globalOptions,
        ) as typeof result);
    writeConformanceOutput(
      renderConformanceForCli(outputResult, reporter, globalOptions.format),
    );
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });

  apps
    .command("conformance-suite")
    .description("Run MCP Apps conformance runs from a JSON config file")
    .requiredOption("--config <path>", "Path to JSON config file")
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const globalOptions = getConformanceGlobals(command, reporter);
      const config = loadAppsSuiteConfig(options.config as string);
      const target = config.target.command ?? config.target.url ?? "apps-suite";
      const collector = globalOptions.rpc
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;
      const suite = new MCPAppsConformanceSuite({
        ...config,
        target: {
          ...config.target,
          ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
        },
      });
      const result = await suite.run();

      const outputResult = reporter
        ? result
        : (withRpcLogsIfRequested(
            result,
            collector,
            globalOptions,
          ) as typeof result);
      writeConformanceOutput(
        renderConformanceForCli(outputResult, reporter, globalOptions.format),
      );
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowedValues: readonly string[],
): string[] {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}

export function buildAppsConformanceConfig(
  options: AppsConformanceOptions,
): MCPAppsConformanceConfig {
  const serverConfig = parseServerConfig(options);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_APPS_CHECK_CATEGORIES,
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`,
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_APPS_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${
        invalidCheckIds.length === 1 ? "" : "s"
      }: ${invalidCheckIds.join(", ")}`,
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
                APPS_CHECK_IDS_BY_CATEGORY[category as MCPAppsCheckCategory],
            ),
          ),
        )
      : undefined;

  return {
    ...serverConfig,
    ...(resolvedCheckIds && resolvedCheckIds.length > 0
      ? { checkIds: resolvedCheckIds as MCPAppsConformanceConfig["checkIds"] }
      : {}),
  };
}
