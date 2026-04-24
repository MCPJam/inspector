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
} from "../lib/apps.js";
import { loadAppsSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceResult,
  resolveConformanceOutputFormat,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
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
  resolveAliasedStringOption,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import {
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";

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
    format: resolveConformanceOutputFormat(options.format, process.stdout.isTTY),
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
      ),
  ).action(async (options, command) => {
    const globalOptions = getConformanceGlobals(command);
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

    writeConformanceOutput(
      renderConformanceResult(
        withRpcLogsIfRequested(result, collector, globalOptions) as typeof result,
        globalOptions.format,
      ),
    );
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });

  apps
    .command("conformance-suite")
    .description("Run MCP Apps conformance runs from a JSON config file")
    .requiredOption("--config <path>", "Path to JSON config file")
    .action(async (options, command) => {
      const globalOptions = getConformanceGlobals(command);
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

      writeConformanceOutput(
        renderConformanceResult(
          withRpcLogsIfRequested(result, collector, globalOptions) as typeof result,
          globalOptions.format,
        ),
      );
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  addRetryOptions(
    addSharedServerOptions(
      apps
        .command("mcp-widget")
        .description("Fetch hosted-style MCP App widget content")
        .option("--resource-uri <uri>", "Widget resource URI")
        .option("--uri <uri>", "Alias for --resource-uri")
        .requiredOption(
          "--tool-id <id>",
          "Tool call id used for runtime injection",
        )
        .requiredOption(
          "--tool-name <name>",
          "Tool name used for runtime injection",
        )
        .option("--tool-input <json>", "Tool input payload as JSON")
        .option("--tool-output <json>", "Tool output payload as JSON")
        .option("--theme <theme>", "Widget theme: light or dark")
        .option("--csp-mode <mode>", "CSP mode: permissive or widget-declared")
        .option("--template <uri>", "Optional ui:// template override")
        .option("--view-mode <mode>", "Widget view mode")
        .option("--view-params <json>", "Widget view params as JSON"),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const resourceUri = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "resourceUri", flag: "--resource-uri" },
        { key: "uri", flag: "--uri" },
      ],
      "Widget resource URI",
      { required: true },
    ) as string;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        buildMcpWidgetContent(manager, serverId, {
          resourceUri,
          toolId: options.toolId as string,
          toolName: options.toolName as string,
          toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
          toolOutput: parseJsonValue(options.toolOutput),
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
        .option("--resource-uri <uri>", "Widget resource URI")
        .option("--uri <uri>", "Alias for --resource-uri")
        .requiredOption(
          "--tool-id <id>",
          "Tool call id used for runtime injection",
        )
        .requiredOption(
          "--tool-name <name>",
          "Tool name used for runtime injection",
        )
        .option("--tool-input <json>", "Tool input payload as JSON")
        .option("--tool-output <json>", "Tool output payload as JSON")
        .option(
          "--tool-response-metadata <json>",
          "Tool response metadata as a JSON object",
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
    const resourceUri = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "resourceUri", flag: "--resource-uri" },
        { key: "uri", flag: "--uri" },
      ],
      "Widget resource URI",
      { required: true },
    ) as string;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        buildChatGptWidgetContent(manager, serverId, {
          uri: resourceUri,
          toolId: options.toolId as string,
          toolName: options.toolName as string,
          toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
          toolOutput: parseJsonValue(options.toolOutput),
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

function parseJsonValue(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw usageError("Value must be valid JSON.", {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseTheme(value: string | undefined): "light" | "dark" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "light" || value === "dark") {
    return value;
  }
  throw usageError(`Invalid theme "${value}". Use "light" or "dark".`);
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
      `Unknown check id${invalidCheckIds.length === 1 ? "" : "s"}: ${invalidCheckIds.join(", ")}`,
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
