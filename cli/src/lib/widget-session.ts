import type { MCPServerConfig } from "@mcpjam/sdk";
import { InspectorApiClient } from "./inspector-api.js";
import { operationalError, usageError } from "./output.js";
import {
  resolveRenderRequestTimeoutMs,
  type WidgetRenderClient,
  type WidgetRenderStatus,
} from "./widget-render.js";

/**
 * widget-session.ts — CLI client for the local Inspector's interactive
 * widget-render sessions (`POST/DELETE /api/mcp/widget-session*`), backing
 * `mcpjam apps session start|action|close`. Like widget-render.ts, the wire
 * contract is mirrored here (the CLI doesn't depend on `@mcpjam/inspector`); the
 * session is held server-side and the external agent steps through it.
 *
 * TWO WAYS TO DRIVE, and the second is why a text-only agent can use this at
 * all: `action` is COORDINATE-based, which assumes the caller can see pixels.
 * `snapshot` + `scripted-step` close that — the snapshot returns controls by
 * role/name/testId and the step accepts the same vocabulary back.
 */

/** A Computer-Use action the harness can apply (mirror of the server spec). */
export interface BrowserActionSpec {
  action:
    | "screenshot"
    | "left_click"
    | "double_click"
    | "right_click"
    | "mouse_move"
    | "type"
    | "key"
    | "scroll"
    | "wait";
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
}

const BROWSER_ACTIONS: ReadonlySet<BrowserActionSpec["action"]> = new Set([
  "screenshot",
  "left_click",
  "double_click",
  "right_click",
  "mouse_move",
  "type",
  "key",
  "scroll",
  "wait",
]);
const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
]);

export interface WidgetToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  elapsedMs: number;
}

/** `start` response (renders keepMounted; sessionId present only on `rendered`). */
export interface WidgetSessionStartResponse {
  sessionId?: string;
  status: WidgetRenderStatus;
  mountedWidgetId?: string;
  viewport?: { width: number; height: number };
  expiresAt?: number;
  idleTimeoutMs?: number;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs?: number;
  hint?: string;
}

export interface WidgetSessionActionResponse {
  action: BrowserActionSpec;
  screenshotBase64?: string;
  widgetToolCalls: WidgetToolCall[];
  note?: string;
  elapsedMs?: number;
  expiresAt?: number;
}

export interface WidgetSessionCloseResponse {
  closed: boolean;
}

export interface RunWidgetSessionStartOptions {
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

/** Start a session: ensure the backend, connect the server, render keepMounted. */
export async function runWidgetSessionStart(
  options: RunWidgetSessionStartOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetSessionStartResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });

  await client.ensureBackend({
    startIfNeeded: options.startIfNeeded ?? true,
    timeoutMs: options.timeoutMs,
  });
  await client.connectServer(options.serverName, options.config, {
    timeoutMs: options.timeoutMs,
  });

  const response = await client.request("/api/mcp/widget-session", {
    method: "POST",
    body: {
      serverId: options.serverName,
      toolName: options.toolName,
      parameters: options.parameters,
      ...(options.injectOpenAiCompat ? { injectOpenAiCompat: true } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
    },
    // The first render may install Chromium — wait generously.
    timeoutMs: resolveRenderRequestTimeoutMs(options.timeoutMs),
  });

  return normalizeStartResponse(response);
}

export interface RunWidgetSessionActionOptions {
  baseUrl?: string;
  sessionId: string;
  action: BrowserActionSpec;
  timeoutMs: number;
}

/** Drive an action on an existing session (no connect/start — the session
 *  lives on the already-running Inspector). */
export async function runWidgetSessionAction(
  options: RunWidgetSessionActionOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetSessionActionResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });

  // A session only exists on a running Inspector; don't auto-start a fresh one
  // (it wouldn't hold the session).
  await client.ensureBackend({ startIfNeeded: false, timeoutMs: options.timeoutMs });

  const response = await client.request(
    `/api/mcp/widget-session/${encodeURIComponent(options.sessionId)}/action`,
    {
      method: "POST",
      body: { action: options.action },
      timeoutMs: options.timeoutMs,
    },
  );

  return normalizeActionResponse(response, options.action);
}

/** One addressable control from a snapshot. */
export interface SnapshotElement {
  role?: { role: string; name?: string };
  testId?: string;
  text?: string;
  ambiguous?: true;
}

export interface WidgetSnapshotResponse {
  snapshot: {
    mode: string;
    tree: string;
    elements: SnapshotElement[];
    truncated?: true;
    capturedAt: number;
    note?: string;
  };
  expiresAt?: number;
}

export interface WidgetScriptedStepResponse {
  step: unknown;
  ok: boolean;
  reason?: string;
  screenshotBase64?: string;
  widgetToolCalls: WidgetToolCall[];
  followUps: string[];
  note?: string;
  elapsedMs?: number;
  expiresAt?: number;
}

export interface RunWidgetSessionSnapshotOptions {
  baseUrl?: string;
  sessionId: string;
  timeoutMs: number;
}

/**
 * Read the mounted widget as an accessibility tree plus addressable controls.
 *
 * A READ: it refreshes the session's idle TTL but does not spend the widget's
 * interaction budget, so an agent can look before every step without trading
 * away the steps it came to make.
 */
export async function runWidgetSessionSnapshot(
  options: RunWidgetSessionSnapshotOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetSnapshotResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });
  await client.ensureBackend({
    startIfNeeded: false,
    timeoutMs: options.timeoutMs,
  });
  const response = (await client.request(
    `/api/mcp/widget-session/${encodeURIComponent(options.sessionId)}/snapshot`,
    { method: "GET", timeoutMs: options.timeoutMs },
  )) as WidgetSnapshotResponse;
  if (!response?.snapshot) {
    throw operationalError("The Inspector returned no snapshot.");
  }
  return response;
}

export interface RunWidgetSessionScriptedStepOptions {
  baseUrl?: string;
  sessionId: string;
  step: unknown;
  priorWidgetToolCalls?: WidgetToolCall[];
  timeoutMs: number;
}

/**
 * Drive one SEMANTIC step — click/type/key/scroll/wait/assert — addressed by
 * role, name or test id rather than by pixel coordinate.
 */
export async function runWidgetSessionScriptedStep(
  options: RunWidgetSessionScriptedStepOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetScriptedStepResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });
  await client.ensureBackend({
    startIfNeeded: false,
    timeoutMs: options.timeoutMs,
  });
  return (await client.request(
    `/api/mcp/widget-session/${encodeURIComponent(
      options.sessionId,
    )}/scripted-step`,
    {
      method: "POST",
      body: {
        step: options.step,
        ...(options.priorWidgetToolCalls
          ? { priorWidgetToolCalls: options.priorWidgetToolCalls }
          : {}),
      },
      timeoutMs: options.timeoutMs,
    },
  )) as WidgetScriptedStepResponse;
}

/**
 * Parse `--step` as JSON and reject anything that is not an object.
 *
 * Deliberately NOT validated field-by-field here: the server owns the step
 * schema, and a second copy in the CLI would drift into rejecting steps the
 * server accepts. This only guarantees the server receives a shape it can
 * parse and report on.
 */
/**
 * Parse `--prior-tool-calls` — the widget tool calls earlier steps produced.
 *
 * The server DRAINS its buffer after every step, so it cannot see history: a
 * `widgetToolCalled` assertion is only answerable against what the caller has
 * accumulated. Without this the assertion always saw an empty list and could
 * never pass, even when the previous step's own output showed the call.
 */
export function parsePriorWidgetToolCalls(
  raw: string | undefined,
): WidgetToolCall[] | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(
      `--prior-tool-calls is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string",
    )
  ) {
    throw usageError(
      "--prior-tool-calls must be a JSON array of the `widgetToolCalls` entries earlier steps returned.",
    );
  }
  return parsed as WidgetToolCall[];
}

export function parseScriptedStepInput(raw: string | undefined): unknown {
  const text = raw?.trim();
  if (!text) {
    throw usageError("--step needs a JSON object, e.g. --step '{\"kind\":\"click\",\"target\":{\"role\":{\"role\":\"button\",\"name\":\"Submit\"}}}'.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(
      `--step is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--step must be a JSON object.");
  }
  return parsed;
}

export interface RunWidgetSessionCloseOptions {
  baseUrl?: string;
  sessionId: string;
  timeoutMs: number;
}

/** Close + dispose a session. */
export async function runWidgetSessionClose(
  options: RunWidgetSessionCloseOptions,
  deps: { client?: WidgetRenderClient } = {},
): Promise<WidgetSessionCloseResponse> {
  const client =
    deps.client ?? new InspectorApiClient({ baseUrl: options.baseUrl });

  await client.ensureBackend({ startIfNeeded: false, timeoutMs: options.timeoutMs });

  const response = await client.request(
    `/api/mcp/widget-session/${encodeURIComponent(options.sessionId)}`,
    { method: "DELETE", timeoutMs: options.timeoutMs },
  );

  const closed = Boolean(
    response && typeof response === "object"
      ? (response as { closed?: unknown }).closed
      : false,
  );
  return { closed };
}

/**
 * Build a `BrowserActionSpec` from `apps session action` flags. `--action` is
 * required; the rest apply per action type and are validated here so a bad
 * action fails before contacting Inspector.
 */
export function parseBrowserActionSpec(options: {
  action?: string;
  coordinate?: string;
  text?: string;
  scrollDirection?: string;
  scrollAmount?: string;
  duration?: string;
}): BrowserActionSpec {
  const action = options.action?.trim();
  if (!action) {
    throw usageError("--action is required. Use --action <type>.");
  }
  if (!BROWSER_ACTIONS.has(action as BrowserActionSpec["action"])) {
    throw usageError(
      `Invalid action "${action}". Use one of: ${[...BROWSER_ACTIONS].join(", ")}.`,
    );
  }
  const spec: BrowserActionSpec = {
    action: action as BrowserActionSpec["action"],
  };

  if (options.coordinate !== undefined) {
    spec.coordinate = parseCoordinate(options.coordinate);
  }
  if (options.text !== undefined) {
    spec.text = options.text;
  }
  if (options.scrollDirection !== undefined) {
    const dir = options.scrollDirection.trim();
    if (!SCROLL_DIRECTIONS.has(dir)) {
      throw usageError(
        `Invalid --scroll-direction "${options.scrollDirection}". Use up, down, left, or right.`,
      );
    }
    spec.scrollDirection = dir as BrowserActionSpec["scrollDirection"];
  }
  if (options.scrollAmount !== undefined) {
    const scrollAmount = parseFiniteNumber(
      options.scrollAmount,
      "--scroll-amount",
    );
    if (scrollAmount <= 0) {
      throw usageError("--scroll-amount must be greater than 0.");
    }
    spec.scrollAmount = scrollAmount;
  }
  if (options.duration !== undefined) {
    const duration = parseFiniteNumber(options.duration, "--duration");
    if (duration < 0) {
      throw usageError("--duration must be greater than or equal to 0.");
    }
    spec.duration = duration;
  }
  return spec;
}

function parseCoordinate(value: string): [number, number] {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) {
    throw usageError(`Invalid --coordinate "${value}". Use "x,y", e.g. 640,400.`);
  }
  return [Number(match[1]), Number(match[2])];
}

function parseFiniteNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw usageError(`Invalid ${flag} "${value}". Expected a number.`);
  }
  return parsed;
}

function normalizeStartResponse(value: unknown): WidgetSessionStartResponse {
  if (!value || typeof value !== "object") {
    throw operationalError("Inspector widget-session response was invalid.", value);
  }
  const r = value as Record<string, unknown>;
  if (typeof r.status !== "string") {
    throw operationalError(
      "Inspector widget-session response was missing a status.",
      value,
    );
  }
  // A `rendered` verdict without a sessionId is unusable — the agent has nothing
  // to step. Fail rather than let `--require-render` exit 0 on it.
  if (r.status === "rendered" && typeof r.sessionId !== "string") {
    throw operationalError(
      "Inspector widget-session response was rendered but missing a sessionId.",
      value,
    );
  }
  return {
    status: r.status as WidgetRenderStatus,
    ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
    ...(typeof r.mountedWidgetId === "string"
      ? { mountedWidgetId: r.mountedWidgetId }
      : {}),
    ...(isViewport(r.viewport) ? { viewport: r.viewport } : {}),
    ...(typeof r.expiresAt === "number" ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.idleTimeoutMs === "number"
      ? { idleTimeoutMs: r.idleTimeoutMs }
      : {}),
    ...(typeof r.resourceUri === "string" ? { resourceUri: r.resourceUri } : {}),
    ...(typeof r.bridgeInitialized === "boolean"
      ? { bridgeInitialized: r.bridgeInitialized }
      : {}),
    ...(typeof r.screenshotBase64 === "string"
      ? { screenshotBase64: r.screenshotBase64 }
      : {}),
    ...(Array.isArray(r.consoleErrors)
      ? { consoleErrors: r.consoleErrors.map(String) }
      : {}),
    ...(Array.isArray(r.blockedRequests)
      ? { blockedRequests: r.blockedRequests.map(String) }
      : {}),
    ...(typeof r.elapsedMs === "number" ? { elapsedMs: r.elapsedMs } : {}),
    ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
  };
}

function normalizeActionResponse(
  value: unknown,
  fallbackAction: BrowserActionSpec,
): WidgetSessionActionResponse {
  if (!value || typeof value !== "object") {
    throw operationalError(
      "Inspector widget-session action response was invalid.",
      value,
    );
  }
  const r = value as Record<string, unknown>;
  return {
    action: (r.action as BrowserActionSpec) ?? fallbackAction,
    widgetToolCalls: Array.isArray(r.widgetToolCalls)
      ? (r.widgetToolCalls as WidgetToolCall[])
      : [],
    ...(typeof r.screenshotBase64 === "string"
      ? { screenshotBase64: r.screenshotBase64 }
      : {}),
    ...(typeof r.note === "string" ? { note: r.note } : {}),
    ...(typeof r.elapsedMs === "number" ? { elapsedMs: r.elapsedMs } : {}),
    ...(typeof r.expiresAt === "number" ? { expiresAt: r.expiresAt } : {}),
  };
}

function isViewport(value: unknown): value is { width: number; height: number } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number"
  );
}

/* ---- output shaping (same screenshot conventions as `apps render`) ---- */

export interface WidgetSessionStartOutput {
  status: WidgetRenderStatus;
  sessionId?: string;
  mountedWidgetId?: string;
  viewport?: { width: number; height: number };
  expiresAt?: number;
  idleTimeoutMs?: number;
  toolName?: string;
  serverName?: string;
  observation: {
    consoleErrors?: string[];
    blockedRequests?: string[];
    resourceUri?: string;
    bridgeInitialized?: boolean;
    elapsedMs?: number;
  };
  screenshotCaptured: boolean;
  screenshotPath?: string;
  screenshotBase64?: string;
  hint?: string;
}

export function buildWidgetSessionStartOutput(
  response: WidgetSessionStartResponse,
  options: {
    screenshotPath?: string;
    includeBase64?: boolean;
    toolName?: string;
    serverName?: string;
  } = {},
): WidgetSessionStartOutput {
  const screenshotCaptured =
    typeof response.screenshotBase64 === "string" &&
    response.screenshotBase64.length > 0;
  return {
    status: response.status,
    ...(response.sessionId ? { sessionId: response.sessionId } : {}),
    ...(response.mountedWidgetId
      ? { mountedWidgetId: response.mountedWidgetId }
      : {}),
    ...(response.viewport ? { viewport: response.viewport } : {}),
    ...(response.expiresAt !== undefined
      ? { expiresAt: response.expiresAt }
      : {}),
    ...(response.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: response.idleTimeoutMs }
      : {}),
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

export interface WidgetSessionActionOutput {
  action: BrowserActionSpec;
  widgetToolCalls: WidgetToolCall[];
  note?: string;
  elapsedMs?: number;
  expiresAt?: number;
  screenshotCaptured: boolean;
  screenshotPath?: string;
  screenshotBase64?: string;
}

export function buildWidgetSessionActionOutput(
  response: WidgetSessionActionResponse,
  options: { screenshotPath?: string; includeBase64?: boolean } = {},
): WidgetSessionActionOutput {
  const screenshotCaptured =
    typeof response.screenshotBase64 === "string" &&
    response.screenshotBase64.length > 0;
  return {
    action: response.action,
    widgetToolCalls: response.widgetToolCalls,
    ...(response.note ? { note: response.note } : {}),
    ...(response.elapsedMs !== undefined
      ? { elapsedMs: response.elapsedMs }
      : {}),
    ...(response.expiresAt !== undefined
      ? { expiresAt: response.expiresAt }
      : {}),
    screenshotCaptured,
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    ...(options.includeBase64 && screenshotCaptured
      ? { screenshotBase64: response.screenshotBase64 }
      : {}),
  };
}
