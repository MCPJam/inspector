import { Command } from "commander";
import path from "node:path";
import { type MCPServerConfig, type RetryPolicy } from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral.js";
import {
  InspectorApiClient,
  delay,
  type InspectorCommandResponse,
} from "../lib/inspector-api.js";
import { parseTheme } from "../lib/apps.js";
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
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";

interface AppsDebugOptions extends SharedServerTargetOptions {
  toolName?: string;
  params?: string;
  ui?: boolean;
  inspectorUrl?: string;
  out?: string;
  serverName?: string;
  protocol?: string;
  device?: string;
  theme?: string;
  locale?: string;
  timeZone?: string;
}

type AppRenderContext = {
  protocol?: "mcp-apps" | "openai-sdk";
  deviceType?: "mobile" | "tablet" | "desktop" | "custom";
  theme?: "light" | "dark";
  locale?: string;
  timeZone?: string;
};

export function registerAppsDebugCommand(parent: Command): void {
  addRetryOptions(
    addSharedServerOptions(
      parent
        .command("debug")
        .description("Debug an MCP App tool call from the CLI")
        .requiredOption("--tool-name <name>", "Tool name to execute")
        .option(
          "--params <json|@file>",
          "Tool parameters as JSON, @path, or - for stdin",
        )
        .option(
          "--ui",
          "Open the Inspector UI to render the App after execution",
        )
        .option("--inspector-url <url>", "Local Inspector base URL (with --ui)")
        .option(
          "--server-name <name>",
          "Server name inside Inspector (with --ui)",
        )
        .option(
          "--protocol <protocol>",
          'Render protocol: "mcp-apps" or "openai-sdk" (with --ui)',
        )
        .option(
          "--device <device>",
          'Render device: "mobile", "tablet", "desktop", or "custom" (with --ui)',
        )
        .option(
          "--theme <theme>",
          'Render theme: "light" or "dark" (with --ui)',
        )
        .option("--locale <locale>", "Render locale (with --ui)")
        .option("--time-zone <iana>", "Render IANA timezone (with --ui)")
        .option("--out <path>", "Write the full debug artifact to a JSON file"),
    ),
  ).action(async (options: AppsDebugOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const toolName = options.toolName as string;
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};
    const serverName =
      typeof options.serverName === "string" && options.serverName.trim()
        ? options.serverName.trim()
        : buildInspectorServerName(options);

    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const sdkResult = await runSdkAppsDebug({
      config,
      params,
      retryPolicy,
      target,
      toolName,
    });

    const uiResult = options.ui
      ? await runUiRender({
          baseUrl: options.inspectorUrl,
          config,
          params,
          renderContext: {
            protocol: parseRenderProtocol(options.protocol),
            deviceType: parseRenderDevice(options.device),
            theme: parseTheme(options.theme),
            locale: trimOptional(options.locale),
            timeZone: trimOptional(options.timeZone),
          },
          serverName,
          timeoutMs: globalOptions.timeout,
          toolName,
          toolResult: sdkResult.execution,
        })
      : undefined;
    const inspectorRenderError = uiResult
      ? findInspectorRenderError(uiResult)
      : undefined;
    const sdkExecutionError = normalizeSdkExecutionError(sdkResult.execution);

    const payload = {
      success: !inspectorRenderError && !sdkExecutionError,
      command: "apps debug",
      inspectorUi: Boolean(options.ui),
      target,
      toolName,
      params,
      ...sdkResult,
      ...(uiResult ? { inspectorRender: uiResult } : {}),
      ...(inspectorRenderError
        ? { error: inspectorRenderError }
        : sdkExecutionError
        ? { error: sdkExecutionError }
        : {}),
    };

    if (inspectorRenderError || sdkExecutionError) {
      setProcessExitCode(1);
    }

    if (options.out) {
      const artifactPath = await writeJsonArtifact(options.out, payload);
      writeResult({ ...payload, artifactPath }, globalOptions.format);
      return;
    }

    writeResult(payload, globalOptions.format);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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

async function runUiRender(options: {
  baseUrl?: string;
  config: MCPServerConfig;
  params: Record<string, unknown>;
  renderContext: AppRenderContext;
  serverName: string;
  timeoutMs: number;
  toolName: string;
  toolResult: unknown;
}) {
  const client = new InspectorApiClient({ baseUrl: options.baseUrl });
  const ensureResult = await client.ensure({
    openBrowser: true,
    startIfNeeded: true,
    tab: "app-builder",
    timeoutMs: options.timeoutMs,
  });

  await client.connectServer(options.serverName, options.config);

  const renderResult = await runInspectorAppRender({
    client,
    params: options.params,
    renderContext: options.renderContext,
    serverName: options.serverName,
    timeoutMs: options.timeoutMs,
    toolName: options.toolName,
    toolResult: options.toolResult,
  });

  return {
    baseUrl: ensureResult.baseUrl,
    inspectorStarted: ensureResult.started,
    ...renderResult,
  };
}

async function runInspectorAppRender(options: {
  client: InspectorApiClient;
  params: Record<string, unknown>;
  renderContext: AppRenderContext;
  serverName: string;
  timeoutMs: number;
  toolName: string;
  toolResult: unknown;
}) {
  const openAppBuilder = await executeInspectorCommandWithClient(options, {
    type: "openAppBuilder",
    payload: { serverName: options.serverName },
    timeoutMs: options.timeoutMs,
  });
  if (openAppBuilder.status === "error") {
    return { openAppBuilder };
  }

  const contextPayload = compactRecord(options.renderContext);
  const setAppContext =
    Object.keys(contextPayload).length > 0
      ? await executeInspectorCommandWithClient(options, {
          type: "setAppContext",
          payload: contextPayload,
          timeoutMs: options.timeoutMs,
        })
      : undefined;
  if (setAppContext?.status === "error") {
    return { openAppBuilder, setAppContext };
  }

  const renderToolResult = await executeInspectorCommandWithClient(options, {
    type: "renderToolResult",
    payload: {
      surface: "app-builder",
      serverName: options.serverName,
      toolName: options.toolName,
      parameters: options.params,
      result: options.toolResult,
    },
    timeoutMs: options.timeoutMs,
  });
  if (renderToolResult.status === "error") {
    return {
      openAppBuilder,
      ...(setAppContext ? { setAppContext } : {}),
      renderToolResult,
    };
  }

  const snapshotApp = await executeInspectorCommandWithClient(options, {
    type: "snapshotApp",
    payload: { surface: "app-builder" },
    timeoutMs: options.timeoutMs,
  });

  return {
    openAppBuilder,
    ...(setAppContext ? { setAppContext } : {}),
    renderToolResult,
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
  // The global CLI --timeout is the retry budget here. The default is bounded,
  // and explicit larger values are honored for slower Inspector sessions.
  const deadline = startedAt + options.timeoutMs;

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

// Prefer downstream render errors first because they carry the most specific
// user-facing failure, even if an earlier setup step also reports an error.
function findInspectorRenderError(
  renderResult: Record<string, unknown>,
): Extract<InspectorCommandResponse, { status: "error" }>["error"] | undefined {
  const priority = [
    "renderToolResult",
    "setAppContext",
    "openAppBuilder",
    "snapshot",
    "snapshotApp",
  ];
  for (const key of priority) {
    const value = renderResult[key];
    if (
      value &&
      typeof value === "object" &&
      (value as InspectorCommandResponse).status === "error"
    ) {
      return (value as Extract<InspectorCommandResponse, { status: "error" }>)
        .error;
    }
  }
  return undefined;
}

function normalizeSdkExecutionError(
  execution: unknown,
): { code: string; message: string; details?: unknown } | undefined {
  if (!execution || typeof execution !== "object") {
    return undefined;
  }

  const record = execution as Record<string, unknown>;
  const result =
    record.result && typeof record.result === "object"
      ? (record.result as Record<string, unknown>)
      : record;
  if (result.isError !== true) {
    return undefined;
  }

  const message = extractSdkErrorMessage(result) ?? "Tool execution failed.";
  return {
    code: "tool_execution_failed",
    message,
    details: execution,
  };
}

function extractSdkErrorMessage(
  result: Record<string, unknown>,
): string | undefined {
  if (typeof result.error === "string") {
    return result.error;
  }
  if (typeof result.message === "string") {
    return result.message;
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).text === "string"
        ? ((entry as Record<string, unknown>).text as string)
        : undefined,
    )
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n");
  return text || undefined;
}

function buildAppsDebugResult(options: {
  execution: unknown;
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
  };
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

function buildInspectorServerName(options: SharedServerTargetOptions): string {
  if (typeof options.url === "string" && options.url.trim()) {
    try {
      const parsed = new URL(options.url);
      const host = parsed.port
        ? `${parsed.hostname}-${parsed.port}`
        : parsed.hostname;
      const raw =
        `${host}${parsed.pathname}`
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
