import path from "node:path";
import type { MCPServerConfig } from "@mcpjam/sdk";
import {
  InspectorApiClient,
  delay,
  type InspectorCommandResponse,
} from "./inspector-api.js";
import { operationalError, usageError } from "./output.js";
import type { SharedServerTargetOptions } from "./server-config.js";

export type AppRenderContext = {
  protocol?: "mcp-apps" | "openai-sdk";
  deviceType?: "mobile" | "tablet" | "desktop" | "custom";
  theme?: "light" | "dark";
  locale?: string;
  timeZone?: string;
};

type InspectorAppRenderResult = {
  openAppBuilder: InspectorCommandResponse;
  setAppContext?: InspectorCommandResponse;
  renderToolResult?: InspectorCommandResponse;
  snapshot?: InspectorCommandResponse;
};

type InspectorUiRenderResult = InspectorAppRenderResult & {
  baseUrl: string;
  browserOpenRequested: boolean;
  browserUrl: string;
  frontendUrl?: string;
  hasActiveClient: boolean;
  inspectorStarted: boolean;
};

export async function runUiRender(options: {
  baseUrl?: string;
  config: MCPServerConfig;
  openBrowser?: boolean;
  params: Record<string, unknown>;
  renderContext: AppRenderContext;
  serverName: string;
  startIfNeeded?: boolean;
  timeoutMs: number;
  toolName: string;
  toolResult: unknown;
}): Promise<InspectorUiRenderResult> {
  const client = new InspectorApiClient({ baseUrl: options.baseUrl });
  const openBrowser = options.openBrowser === true;
  const ensureResult = await client.ensure({
    openBrowser,
    startIfNeeded: options.startIfNeeded ?? true,
    tab: "app-builder",
    timeoutMs: options.timeoutMs,
  });

  if (!ensureResult.hasActiveClient && !openBrowser) {
    const startedNote = ensureResult.started
      ? " Inspector was just started by the CLI and is still running."
      : "";
    throw operationalError(
      `Inspector has no active browser client.${startedNote} Open the Inspector App Builder URL in your browser, then rerun \`tools call --ui\`; or pass \`--open\` to let the CLI open a system browser.`,
      {
        inspectorBrowserUrl: ensureResult.url,
        inspectorStarted: ensureResult.started,
      },
    );
  }

  await client.connectServer(options.serverName, options.config, {
    timeoutMs: options.timeoutMs,
  });

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
    browserUrl: ensureResult.url,
    ...(ensureResult.frontendUrl
      ? { frontendUrl: ensureResult.frontendUrl }
      : {}),
    browserOpenRequested: openBrowser,
    hasActiveClient: ensureResult.hasActiveClient,
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
}): Promise<InspectorAppRenderResult> {
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
  const deadline = startedAt + options.timeoutMs;
  let lastResponse: InspectorCommandResponse | undefined;

  do {
    const response = await options.client.executeCommand(request);
    lastResponse = response;
    const retryable =
      response.status === "error" &&
      (response.error.code === "no_active_client" ||
        response.error.code === "unsupported_in_mode" ||
        response.error.code === "disconnected_server");
    if (!retryable) {
      return response;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return response;
    }
    await delay(Math.min(500, remaining));
  } while (Date.now() < deadline);

  if (!lastResponse) {
    throw new Error("Inspector command was not executed.");
  }
  return lastResponse;
}

export function findInspectorRenderError(
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

export function parseRenderProtocol(
  value: string | undefined,
): AppRenderContext["protocol"] {
  if (value === undefined) return undefined;
  if (value === "mcp-apps" || value === "openai-sdk") return value;
  throw usageError(
    `Invalid protocol "${value}". Use "mcp-apps" or "openai-sdk".`,
  );
}

export function parseRenderDevice(
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

export function parseRenderTheme(
  value: string | undefined,
): AppRenderContext["theme"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "light" || value === "dark") {
    return value;
  }
  throw usageError(`Invalid theme "${value}". Use "light" or "dark".`);
}

export function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildInspectorServerName(
  options: SharedServerTargetOptions,
): string {
  if (typeof options.url === "string" && options.url.trim()) {
    const trimmedUrl = options.url.trim();
    try {
      const parsed = new URL(trimmedUrl);
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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
