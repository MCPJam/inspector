import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceSuite,
  MCPAppsConformanceTest,
  type MCPServerConfig,
  type RetryPolicy,
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
import {
  InspectorApiClient,
  ensureInspector,
  type InspectorCommandResponse,
} from "../lib/inspector-api.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import { listToolsWithMetadata } from "../lib/server-ops.js";
import { writeJsonArtifact } from "../lib/reporting.js";
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

interface AppsDebugOptions extends SharedServerTargetOptions {
  toolName?: string;
  name?: string;
  params?: string;
  toolArgs?: string;
  engine?: string;
  render?: string;
  openInspector?: boolean;
  inspectorUrl?: string;
  out?: string;
  serverName?: string;
  protocol?: string;
  device?: string;
  theme?: string;
  locale?: string;
  timeZone?: string;
}

type AppsDebugEngine = "sdk" | "inspector";
type AppsDebugRender = "none" | "inspector";

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
        .command("debug")
        .description("Debug an MCP App tool call from the CLI")
        .option("--tool-name <name>", "Tool name to execute")
        .option("--name <name>", "Alias for --tool-name")
        .option(
          "--params <json|@file>",
          "Tool parameters as JSON or @path to a JSON file",
        )
        .option("--tool-args <json|@file>", "Alias for --params")
        .option(
          "--engine <engine>",
          'Execution engine: "sdk" or "inspector". Default: "sdk".',
        )
        .option(
          "--render <render>",
          'Render mode: "none" or "inspector". Default: "none".',
        )
        .option(
          "--open-inspector",
          "Open the Inspector browser UI while using Inspector-backed execution",
        )
        .option("--inspector-url <url>", "Local Inspector base URL")
        .option("--server-name <name>", "Server name inside Inspector")
        .option("--protocol <protocol>", 'Render protocol: "mcp-apps" or "openai-sdk"')
        .option("--device <device>", 'Render device: "mobile", "tablet", "desktop", or "custom"')
        .option("--theme <theme>", 'Render theme: "light" or "dark"')
        .option("--locale <locale>", "Render locale")
        .option("--time-zone <iana>", "Render IANA timezone")
        .option("--out <path>", "Write the full debug artifact to a JSON file"),
    ),
  ).action(async (options: AppsDebugOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const toolName = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolName", flag: "--tool-name" },
        { key: "name", flag: "--name" },
      ],
      "Tool name",
      { required: true },
    ) as string;
    const rawParams = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "params", flag: "--params" },
        { key: "toolArgs", flag: "--tool-args" },
      ],
      "Tool parameters",
    );
    const params = await parseJsonRecordOrFile(rawParams, "Tool parameters");
    const render = parseAppsDebugRender(options.render);
    const engine = parseAppsDebugEngine(options.engine, render);
    const serverName =
      typeof options.serverName === "string" && options.serverName.trim()
        ? options.serverName.trim()
        : buildInspectorServerName(options);

    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result =
      engine === "inspector"
        ? await runInspectorAppsDebug({
            baseUrl: options.inspectorUrl,
            config,
            openBrowser: Boolean(options.openInspector) || render === "inspector",
            params,
            render,
            serverName,
            timeoutMs: globalOptions.timeout,
            toolName,
            renderContext: {
              protocol: parseRenderProtocol(options.protocol),
              deviceType: parseRenderDevice(options.device),
              theme: parseTheme(options.theme),
              locale: trimOptional(options.locale),
              timeZone: trimOptional(options.timeZone),
            },
          })
        : await runSdkAppsDebug({
            config,
            params,
            retryPolicy,
            target,
            toolName,
          });

    const payload = {
      success: true,
      command: "apps debug",
      engine,
      render,
      target,
      serverName: engine === "inspector" ? serverName : "__cli__",
      toolName,
      params,
      ...result,
    };

    if (options.out) {
      const artifactPath = await writeJsonArtifact(options.out, payload);
      writeResult({ ...payload, artifactPath }, globalOptions.format);
      return;
    }

    writeResult(payload, globalOptions.format);
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

async function parseJsonRecordOrFile(
  value: string | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  if (value === undefined) {
    return {};
  }

  if (!value.startsWith("@")) {
    return parseJsonRecord(value, label) ?? {};
  }

  const filePath = value.slice(1);
  if (!filePath) {
    throw usageError(`${label} file path is required after @.`);
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw usageError(`Failed to read ${label} file "${filePath}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }

  return parseJsonRecord(content, label) ?? {};
}

async function runSdkAppsDebug(options: {
  config: MCPServerConfig;
  params: Record<string, unknown>;
  retryPolicy?: RetryPolicy;
  target: string;
  toolName: string;
}) {
  return withEphemeralManager(
    options.config,
    async (manager, serverId) => {
      const toolsData = await listToolsWithMetadata(manager, { serverId });
      const execution = await manager.executeTool(
        serverId,
        options.toolName,
        options.params,
      );

      return buildAppsDebugResult({
        execution,
        toolsData,
        toolName: options.toolName,
      });
    },
    {
      retryPolicy: options.retryPolicy,
    },
  );
}

async function runInspectorAppsDebug(options: {
  baseUrl?: string;
  config: MCPServerConfig;
  openBrowser: boolean;
  params: Record<string, unknown>;
  render: AppsDebugRender;
  renderContext: AppRenderContext;
  serverName: string;
  timeoutMs: number;
  toolName: string;
}) {
  const client = new InspectorApiClient({ baseUrl: options.baseUrl });
  const ensureResult = await client.ensure({
    openBrowser: false,
    startIfNeeded: true,
    timeoutMs: options.timeoutMs,
  });

  const connection = await client.connectServer(
    options.serverName,
    options.config,
  );
  const [toolsData, initInfo] = await Promise.all([
    client.listTools(options.serverName),
    client.getInitInfo(options.serverName).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const execution = await client.executeTool(
    options.serverName,
    options.toolName,
    options.params,
  );
  const debugResult = buildAppsDebugResult({
    execution: normalizeInspectorToolExecution(execution),
    rawExecution: execution,
    toolsData,
    toolName: options.toolName,
  });

  if (options.openBrowser) {
    await ensureInspector({
      baseUrl: ensureResult.baseUrl,
      openBrowser: true,
      startIfNeeded: false,
      tab: options.render === "inspector" ? "app-builder" : undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  const renderResult =
    options.render === "inspector"
      ? await runInspectorAppRender({
          client,
          params: options.params,
          renderContext: options.renderContext,
          serverName: options.serverName,
          timeoutMs: options.timeoutMs,
          toolName: options.toolName,
        })
      : undefined;

  return {
    baseUrl: ensureResult.baseUrl,
    inspectorStarted: ensureResult.started,
    connection,
    initInfo,
    ...debugResult,
    ...(renderResult ? { inspectorRender: renderResult } : {}),
  };
}

async function runInspectorAppRender(options: {
  client: InspectorApiClient;
  params: Record<string, unknown>;
  renderContext: AppRenderContext;
  serverName: string;
  timeoutMs: number;
  toolName: string;
}) {
  const openAppBuilder = await executeInspectorCommandWithClient(options, {
    type: "openAppBuilder",
    payload: { serverName: options.serverName },
    timeoutMs: options.timeoutMs,
  });

  const contextPayload = compactRecord(options.renderContext);
  const setAppContext =
    Object.keys(contextPayload).length > 0
      ? await executeInspectorCommandWithClient(options, {
          type: "setAppContext",
          payload: contextPayload,
          timeoutMs: options.timeoutMs,
        })
      : undefined;

  const executeTool = await executeInspectorCommandWithClient(options, {
    type: "executeTool",
    payload: {
      surface: "app-builder",
      serverName: options.serverName,
      toolName: options.toolName,
      parameters: options.params,
    },
    timeoutMs: options.timeoutMs,
  });

  const snapshotApp = await executeInspectorCommandWithClient(options, {
    type: "snapshotApp",
    payload: { surface: "app-builder" },
    timeoutMs: options.timeoutMs,
  });

  return {
    openAppBuilder,
    ...(setAppContext ? { setAppContext } : {}),
    executeTool,
    snapshot: snapshotApp,
  };
}

async function executeInspectorCommandWithClient(
  options: {
    client: InspectorApiClient;
    timeoutMs: number;
  },
  request: Parameters<InspectorApiClient["executeCommand"]>[0],
): Promise<InspectorCommandResponse> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.min(options.timeoutMs, 10_000);

  do {
    const response = await options.client.executeCommand(request);
    const retryable =
      response.status === "error" &&
      (response.error.code === "no_active_client" ||
        response.error.code === "unsupported_in_mode" ||
        response.error.code === "disconnected_server");
    if (!retryable || Date.now() >= deadline) {
      return response;
    }

    await delay(500);
  } while (true);
}

function buildAppsDebugResult(options: {
  execution: unknown;
  rawExecution?: unknown;
  toolsData: unknown;
  toolName: string;
}) {
  const toolsData = normalizeToolsData(options.toolsData);
  const tool = toolsData.tools.find((entry) => entry.name === options.toolName);
  const toolMetadata = toolsData.toolsMetadata[options.toolName] ?? {};
  const ui = extractToolUiMetadata(toolMetadata);

  return {
    tools: {
      count: toolsData.tools.length,
      matched: Boolean(tool),
      ...(tool ? { tool } : {}),
    },
    toolsMetadata: toolsData.toolsMetadata,
    toolMetadata,
    ui,
    execution: options.execution,
    ...(options.rawExecution ? { rawExecution: options.rawExecution } : {}),
  };
}

function normalizeInspectorToolExecution(execution: unknown): unknown {
  if (!execution || typeof execution !== "object") {
    return execution;
  }

  const record = execution as Record<string, unknown>;
  if (record.status === "completed" && "result" in record) {
    return record.result;
  }

  return execution;
}

function normalizeToolsData(value: unknown): {
  tools: Array<Record<string, any> & { name: string }>;
  toolsMetadata: Record<string, Record<string, unknown>>;
} {
  if (!value || typeof value !== "object") {
    return { tools: [], toolsMetadata: {} };
  }

  const record = value as Record<string, unknown>;
  const tools = Array.isArray(record.tools)
    ? record.tools.filter(
        (tool): tool is Record<string, any> & { name: string } =>
          Boolean(
            tool &&
              typeof tool === "object" &&
              typeof (tool as { name?: unknown }).name === "string",
          ),
      )
    : [];
  const toolsMetadata =
    record.toolsMetadata &&
    typeof record.toolsMetadata === "object" &&
    !Array.isArray(record.toolsMetadata)
      ? (record.toolsMetadata as Record<string, Record<string, unknown>>)
      : {};

  return { tools, toolsMetadata };
}

function extractToolUiMetadata(meta: Record<string, unknown>) {
  const nested = meta.ui;
  const mcpAppsResourceUri =
    nested && typeof nested === "object"
      ? (nested as { resourceUri?: unknown }).resourceUri
      : undefined;
  const legacyResourceUri = meta["ui/resourceUri"];
  const openAiOutputTemplate = meta["openai/outputTemplate"];

  return {
    resourceUri:
      typeof mcpAppsResourceUri === "string"
        ? mcpAppsResourceUri
        : typeof legacyResourceUri === "string"
          ? legacyResourceUri
          : typeof openAiOutputTemplate === "string"
            ? openAiOutputTemplate
            : null,
    mcpAppsResourceUri:
      typeof mcpAppsResourceUri === "string" ? mcpAppsResourceUri : null,
    legacyResourceUri:
      typeof legacyResourceUri === "string" ? legacyResourceUri : null,
    openAiOutputTemplate:
      typeof openAiOutputTemplate === "string" ? openAiOutputTemplate : null,
  };
}

function parseAppsDebugEngine(
  value: string | undefined,
  render: AppsDebugRender,
): AppsDebugEngine {
  if (value === undefined) {
    return render === "inspector" ? "inspector" : "sdk";
  }
  if (value !== "sdk" && value !== "inspector") {
    throw usageError(`Invalid engine "${value}". Use "sdk" or "inspector".`);
  }
  if (value === "sdk" && render === "inspector") {
    throw usageError('--render inspector requires --engine inspector.');
  }
  return value;
}

function parseAppsDebugRender(value: string | undefined): AppsDebugRender {
  if (value === undefined || value === "none") {
    return "none";
  }
  if (value === "inspector") {
    return "inspector";
  }
  throw usageError(`Invalid render "${value}". Use "none" or "inspector".`);
}

type AppRenderContext = {
  protocol?: "mcp-apps" | "openai-sdk";
  deviceType?: "mobile" | "tablet" | "desktop" | "custom";
  theme?: "light" | "dark";
  locale?: string;
  timeZone?: string;
};

function parseRenderProtocol(
  value: string | undefined,
): AppRenderContext["protocol"] {
  if (value === undefined) return undefined;
  if (value === "mcp-apps" || value === "openai-sdk") return value;
  throw usageError(
    `Invalid protocol "${value}". Use "mcp-apps" or "openai-sdk".`,
  );
}

function parseRenderDevice(
  value: string | undefined,
): AppRenderContext["deviceType"] {
  if (value === undefined) return undefined;
  if (
    value === "mobile" ||
    value === "tablet" ||
    value === "desktop" ||
    value === "custom"
  ) {
    return value;
  }
  throw usageError(
    `Invalid device "${value}". Use "mobile", "tablet", "desktop", or "custom".`,
  );
}

function compactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildInspectorServerName(options: SharedServerTargetOptions): string {
  if (typeof options.url === "string" && options.url.trim()) {
    try {
      const parsed = new URL(options.url);
      const raw =
        `${parsed.hostname}${parsed.pathname}`
          .replace(/\/+$/, "")
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || parsed.hostname;
      return raw || "inspector-server";
    } catch {
      return "inspector-server";
    }
  }

  if (typeof options.command === "string" && options.command.trim()) {
    return (
      path
        .basename(options.command.trim())
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "inspector-server"
    );
  }

  return "inspector-server";
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
