import { Command } from "commander";
import {
  buildChatGptWidgetContent,
  buildMcpWidgetContent,
} from "../lib/apps";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseServerConfig,
} from "../lib/server-config";
import { usageError, writeResult } from "../lib/output";

export function registerAppsCommands(program: Command): void {
  const apps = program
    .command("apps")
    .description("Fetch MCP App and ChatGPT App widget content");

  addSharedServerOptions(
    apps
      .command("mcp-widget")
      .description("Fetch hosted-style MCP App widget content")
      .requiredOption("--resource-uri <uri>", "Widget resource URI")
      .requiredOption("--tool-id <id>", "Tool call id used for runtime injection")
      .requiredOption("--tool-name <name>", "Tool name used for runtime injection")
      .option("--tool-input <json>", "Tool input payload as JSON")
      .option("--tool-output <json>", "Tool output payload as JSON")
      .option("--theme <theme>", "Widget theme: light or dark")
      .option(
        "--csp-mode <mode>",
        "CSP mode: permissive or widget-declared",
      )
      .option("--template <uri>", "Optional ui:// template override")
      .option("--view-mode <mode>", "Widget view mode")
      .option("--view-params <json>", "Widget view params as JSON"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    apps
      .command("chatgpt-widget")
      .description("Fetch hosted-style ChatGPT App widget content")
      .requiredOption("--uri <uri>", "Widget resource URI")
      .requiredOption("--tool-id <id>", "Tool call id used for runtime injection")
      .requiredOption("--tool-name <name>", "Tool name used for runtime injection")
      .option("--tool-input <json>", "Tool input payload as JSON")
      .option("--tool-output <json>", "Tool output payload as JSON")
      .option(
        "--tool-response-metadata <json>",
        "Tool response metadata as a JSON object",
      )
      .option("--theme <theme>", "Widget theme: light or dark")
      .option(
        "--csp-mode <mode>",
        "CSP mode: permissive or widget-declared",
      )
      .option("--locale <locale>", "Locale override")
      .option("--device-type <type>", "Device type: mobile, tablet, or desktop"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
          uri: options.uri as string,
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
}

function withRpcLogsIfRequested(
  value: unknown,
  collector: ReturnType<typeof createCliRpcLogCollector> | undefined,
  options: { format: string; rpc: boolean },
) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }

  return attachCliRpcLogs(value, collector);
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
