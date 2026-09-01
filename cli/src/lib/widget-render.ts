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
  "ensureBackend" | "connectServerAdhoc" | "request"
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
 * Floor for the render POST timeout. The first render on a machine without
 * Chromium triggers an on-demand Playwright install INSIDE that request, which
 * routinely exceeds the default 30s op timeout. Give the render call a generous
 * floor so the CLI waits for the install (and gets a real verdict, or a
 * `browser_unavailable` hint) instead of aborting with a transport/timeout
 * error. A larger explicit `--timeout` still wins.
 */
const RENDER_REQUEST_TIMEOUT_FLOOR_MS = 5 * 60_000;

/** The render POST timeout: the larger of the caller's timeout and the floor. */
export function resolveRenderRequestTimeoutMs(timeoutMs: number): number {
  return Math.max(timeoutMs, RENDER_REQUEST_TIMEOUT_FLOOR_MS);
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

  await client.connectServerAdhoc(options.serverName, options.config, {
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
    // The render may install Chromium on first use — wait generously rather
    // than abort on the default op timeout.
    timeoutMs: resolveRenderRequestTimeoutMs(options.timeoutMs),
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
 * Upper bound for a viewport edge (px). Mirrors the server's
 * `widget-render` cap so an obviously-invalid size (e.g. `999999x999999`)
 * fails client-side before connecting to the Inspector.
 */
const MAX_VIEWPORT_EDGE = 8192;

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
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_VIEWPORT_EDGE ||
    height > MAX_VIEWPORT_EDGE
  ) {
    throw usageError(
      `Invalid viewport "${value}". Width and height must be between 1 and ${MAX_VIEWPORT_EDGE}.`,
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
  toolName?: string;
  serverName?: string;
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
 * Shape the render observation into the command's JSON envelope. `toolName` and
 * `serverName` echo the request so the result is self-describing in agent logs.
 * The screenshot is delivered out-of-band by default: a file path when
 * `--screenshot-out` was written, and the inline base64 only when
 * `--screenshot-base64` is set, so normal stdout stays free of large image
 * blobs.
 */
export function buildWidgetRenderOutput(
  response: WidgetRenderResponse,
  options: {
    screenshotPath?: string;
    includeBase64?: boolean;
    toolName?: string;
    serverName?: string;
  } = {},
): WidgetRenderOutput {
  const screenshotCaptured =
    typeof response.screenshotBase64 === "string" &&
    response.screenshotBase64.length > 0;

  return {
    status: response.status,
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.serverName ? { serverName: options.serverName } : {}),
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
