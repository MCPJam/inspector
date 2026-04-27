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
import {
  buildChatGptWidgetContent,
  buildMcpWidgetContent,
  parseTheme,
} from "../lib/apps.js";
import { loadAppsSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceReporterResult,
  renderConformanceResult,
  resolveConformanceOutputFormat,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { parseJsonInputValue } from "../lib/json-input.js";
import { parseReporterFormat } from "../lib/reporting.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseRetryPolicy,
  parseServerConfig,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import { registerAppsDebugCommand } from "./apps-debug.js";

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

function getConformanceGlobals(command: Command): {
  format: ConformanceOutputFormat;
  timeout: number;
  rpc: boolean;
} {
  const options = command.optsWithGlobals() as {
    format?: string;
    timeout?: number;
    rpc?: boolean;
  };

  return {
    format: resolveConformanceOutputFormat(
      options.format,
      process.stdout.isTTY,
    ),
    timeout: options.timeout ?? 30_000,
    rpc: options.rpc ?? false,
  };
}

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerAppsCommands(program: Command): void {
  const apps = program
    .command("apps")
    .description(
      "MCP Apps utilities, widget extraction, and conformance checks",
    );

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
    const globalOptions = getConformanceGlobals(command);
    const reporter = parseReporterFormat(options.reporter as string | undefined);
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

    const outputResult = withRpcLogsIfRequested(
      result,
      collector,
      globalOptions,
    ) as typeof result;
    writeConformanceOutput(
      reporter
        ? renderConformanceReporterResult(outputResult, reporter)
        : renderConformanceResult(outputResult, globalOptions.format),
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
      const globalOptions = getConformanceGlobals(command);
      const reporter = parseReporterFormat(options.reporter as string | undefined);
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

      const outputResult = withRpcLogsIfRequested(
        result,
        collector,
        globalOptions,
      ) as typeof result;
      writeConformanceOutput(
        reporter
          ? renderConformanceReporterResult(outputResult, reporter)
          : renderConformanceResult(outputResult, globalOptions.format),
      );
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  registerAppsDebugCommand(apps);

  addRetryOptions(
    addSharedServerOptions(
      apps
        .command("mcp-widget")
        .description("Fetch hosted-style MCP App widget content")
        .requiredOption("--resource-uri <uri>", "Widget resource URI")
        .requiredOption(
          "--tool-id <id>",
          "Tool call id used for runtime injection",
        )
        .requiredOption(
          "--tool-name <name>",
          "Tool name used for runtime injection",
        )
        .option(
          "--tool-input <json>",
          "Tool input payload as JSON, @path, or - for stdin",
        )
        .option(
          "--tool-output <json>",
          "Tool output payload as JSON, @path, or - for stdin",
        )
        .option("--theme <theme>", "Widget theme: light or dark")
        .option("--csp-mode <mode>", "CSP mode: permissive or widget-declared")
        .option("--template <uri>", "Optional ui:// template override")
        .option("--view-mode <mode>", "Widget view mode")
        .option(
          "--view-params <json>",
          "Widget view params as JSON, @path, or - for stdin",
        ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        buildMcpWidgetContent(manager, serverId, {
          resourceUri: options.resourceUri as string,
          toolId: options.toolId as string,
          toolName: options.toolName as string,
          toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
          toolOutput: parseJsonValue(options.toolOutput, "Tool output"),
          theme: parseTheme(options.theme),
          cspMode: parseCspMode(options.cspMode),
          template: options.template as string | undefined,
          viewMode: options.viewMode as string | undefined,
          viewParams: parseJsonRecord(options.viewParams, "View params"),
        }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addRetryOptions(
    addSharedServerOptions(
      apps
        .command("chatgpt-widget")
        .description("Fetch hosted-style ChatGPT App widget content")
        .requiredOption("--resource-uri <uri>", "Widget resource URI")
        .requiredOption(
          "--tool-id <id>",
          "Tool call id used for runtime injection",
        )
        .requiredOption(
          "--tool-name <name>",
          "Tool name used for runtime injection",
        )
        .option(
          "--tool-input <json>",
          "Tool input payload as JSON, @path, or - for stdin",
        )
        .option(
          "--tool-output <json>",
          "Tool output payload as JSON, @path, or - for stdin",
        )
        .option(
          "--tool-response-metadata <json>",
          "Tool response metadata as JSON, @path, or - for stdin",
        )
        .option("--theme <theme>", "Widget theme: light or dark")
        .option("--csp-mode <mode>", "CSP mode: permissive or widget-declared")
        .option("--locale <locale>", "Locale override")
        .option(
          "--device-type <type>",
          "Device type: mobile, tablet, or desktop",
        ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        buildChatGptWidgetContent(manager, serverId, {
          uri: options.resourceUri as string,
          toolId: options.toolId as string,
          toolName: options.toolName as string,
          toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
          toolOutput: parseJsonValue(options.toolOutput, "Tool output"),
          toolResponseMetadata:
            parseJsonRecord(
              options.toolResponseMetadata,
              "Tool response metadata",
            ) ?? null,
          theme: parseTheme(options.theme),
          cspMode: parseCspMode(options.cspMode),
          locale: options.locale as string | undefined,
          deviceType: parseDeviceType(options.deviceType),
        }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });
}

function parseJsonValue(value: string | undefined, label: string): unknown {
  return parseJsonInputValue(value, label);
}

function parseCspMode(
  value: string | undefined,
): "permissive" | "widget-declared" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "permissive" || value === "widget-declared") {
    return value;
  }
  throw usageError(
    `Invalid CSP mode "${value}". Use "permissive" or "widget-declared".`,
  );
}

function parseDeviceType(
  value: string | undefined,
): "mobile" | "tablet" | "desktop" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "mobile" || value === "tablet" || value === "desktop") {
    return value;
  }
  throw usageError(
    `Invalid device type "${value}". Use "mobile", "tablet", or "desktop".`,
  );
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
