import type { MCPServerConfig } from "@mcpjam/sdk";
import { InspectorApiClient } from "./inspector-api.js";
import { operationalError, usageError } from "./output.js";

/**
 * widget-render.ts — CLI client for the local Inspector's headless widget-render
 * capability (`POST /api/mcp/widget-render`), backing `mcpjam apps render`.
 *
 * The CLI deliberately does NOT depend on `@mcpjam/inspector` (and the server's
 * `shared/` is not a clean CLI dependency), so the wire contract is mirrored
 * here as a slim copy — the same convention `inspector-api.ts` uses for the
 * command-bus types. If a single source of truth is wanted later, the contract
 * can move into `@mcpjam/sdk` (which the CLI does depend on).
 */

/** Render verdicts mirrored from the harness's `WidgetRenderStatus`. */
export type WidgetRenderStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

/** Response body of `POST /api/mcp/widget-render`. */
export interface WidgetRenderResponse {
  status: WidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs?: number;
  /** Present on `browser_unavailable`: the install command to remediate. */
  hint?: string;
}

/** The slice of `InspectorApiClient` the render flow uses (injectable for tests). */
export type WidgetRenderClient = Pick<
  InspectorApiClient,
  "ensureBackend" | "connectServer" | "request"
>;

export interface RunWidgetRenderOptions {
  baseUrl?: string;
  config: MCPServerConfig;
  serverName: string;
  toolName: string;
  parameters: Record<string, unknown>;
  injectOpenAiCompat?: boolean;
  viewport?: { width: number; height: number };
  startIfNeeded?: boolean;
  timeoutMs: number;
}

/**
 * Ensure the local Inspector is up (no browser client needed — the harness runs
 * server-side), connect the target server, and request a one-shot headless
 * render of `toolName`'s widget. Returns the parsed render observation.
 */
export async function runWidgetRender(
  options: RunWidgetRenderOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetRenderResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });

  // No browser tab required: the render runs server-side, so only a live
  // backend is needed (no frontend resolution / browser open).
  await client.ensureBackend({
    startIfNeeded: options.startIfNeeded ?? true,
    timeoutMs: options.timeoutMs,
  });

  await client.connectServer(options.serverName, options.config, {
    timeoutMs: options.timeoutMs,
  });

  const response = await client.request("/api/mcp/widget-render", {
    method: "POST",
    body: {
      serverId: options.serverName,
      toolName: options.toolName,
      parameters: options.parameters,
      ...(options.injectOpenAiCompat ? { injectOpenAiCompat: true } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
    },
    timeoutMs: options.timeoutMs,
  });

  return normalizeWidgetRenderResponse(response);
}

const WIDGET_RENDER_STATUSES: ReadonlySet<string> = new Set<WidgetRenderStatus>([
  "rendered",
  "no_ui_resource",
  "resource_read_failed",
  "mount_failed",
  "bridge_timeout",
  "render_error",
  "blank_screenshot",
  "screenshot_failed",
  "browser_unavailable",
]);

function normalizeWidgetRenderResponse(value: unknown): WidgetRenderResponse {
  if (!value || typeof value !== "object") {
    throw operationalError("Inspector widget-render response was invalid.", value);
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !WIDGET_RENDER_STATUSES.has(record.status)
  ) {
    throw operationalError(
      "Inspector widget-render response was missing a known status.",
      value,
    );
  }

  return {
    status: record.status as WidgetRenderStatus,
    ...(typeof record.resourceUri === "string"
      ? { resourceUri: record.resourceUri }
      : {}),
    ...(typeof record.bridgeInitialized === "boolean"
      ? { bridgeInitialized: record.bridgeInitialized }
      : {}),
    ...(typeof record.screenshotBase64 === "string"
      ? { screenshotBase64: record.screenshotBase64 }
      : {}),
    ...(Array.isArray(record.consoleErrors)
      ? { consoleErrors: record.consoleErrors.map(String) }
      : {}),
    ...(Array.isArray(record.blockedRequests)
      ? { blockedRequests: record.blockedRequests.map(String) }
      : {}),
    ...(typeof record.elapsedMs === "number"
      ? { elapsedMs: record.elapsedMs }
      : {}),
    ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
  };
}

/**
 * Parse a `--viewport <WxH>` string (e.g. `1280x800`) into pixel dimensions.
 * Returns undefined when unset; throws a usage error on a malformed value.
 */
export function parseWidgetRenderViewport(
  value: string | undefined,
): { width: number; height: number } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(trimmed);
  if (!match) {
    throw usageError(
      `Invalid viewport "${value}". Use <width>x<height>, e.g. 1280x800.`,
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw usageError(
      `Invalid viewport "${value}". Width and height must be positive.`,
    );
  }

  return { width, height };
}

/**
 * Map `--protocol` to the harness's `injectOpenAiCompat` flag: the OpenAI Apps
 * SDK surface (`openai-sdk`) injects the `window.openai` shim; MCP Apps
 * (`mcp-apps`, the default) does not.
 */
export function resolveWidgetRenderInjectOpenAiCompat(
  protocol: string | undefined,
): boolean {
  if (protocol === undefined) {
    return false;
  }
  if (protocol === "mcp-apps") {
    return false;
  }
  if (protocol === "openai-sdk") {
    return true;
  }
  throw usageError(
    `Invalid protocol "${protocol}". Use "mcp-apps" or "openai-sdk".`,
  );
}

export interface WidgetRenderOutput {
  status: WidgetRenderStatus;
  observation: {
    consoleErrors?: string[];
    blockedRequests?: string[];
    resourceUri?: string;
    bridgeInitialized?: boolean;
    elapsedMs?: number;
  };
  /** True when the harness produced an image, regardless of how it's delivered. */
  screenshotCaptured: boolean;
  screenshotPath?: string;
  screenshotBase64?: string;
  hint?: string;
}

/**
 * Shape the render observation into the command's JSON envelope. The screenshot
 * is delivered out-of-band by default: a file path when `--screenshot-out` was
 * written, and the inline base64 only when `--screenshot-base64` is set, so
 * normal stdout stays free of large image blobs.
 */
export function buildWidgetRenderOutput(
  response: WidgetRenderResponse,
  options: { screenshotPath?: string; includeBase64?: boolean } = {},
): WidgetRenderOutput {
  const screenshotCaptured =
    typeof response.screenshotBase64 === "string" &&
    response.screenshotBase64.length > 0;

  return {
    status: response.status,
    observation: {
      ...(response.consoleErrors
        ? { consoleErrors: response.consoleErrors }
        : {}),
      ...(response.blockedRequests
        ? { blockedRequests: response.blockedRequests }
        : {}),
      ...(response.resourceUri ? { resourceUri: response.resourceUri } : {}),
      ...(response.bridgeInitialized !== undefined
        ? { bridgeInitialized: response.bridgeInitialized }
        : {}),
      ...(response.elapsedMs !== undefined
        ? { elapsedMs: response.elapsedMs }
        : {}),
    },
    screenshotCaptured,
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    ...(options.includeBase64 && screenshotCaptured
      ? { screenshotBase64: response.screenshotBase64 }
      : {}),
    ...(response.hint ? { hint: response.hint } : {}),
  };
}
