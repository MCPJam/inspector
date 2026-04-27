import { closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operationalError } from "./output.js";

const FALLBACK_INSPECTOR_BASE_URL = "http://127.0.0.1:6274";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const COMMAND_FETCH_TIMEOUT_BUFFER_MS = 2_000;
const HEALTH_FETCH_TIMEOUT_MS = 2_000;
const SESSION_TOKEN_TIMEOUT_MS = 3_000;
const STOP_FETCH_TIMEOUT_MS = 3_000;
const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

const TOKEN_TTL_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; fetchedAt: number }>();
const tokenRequests = new Map<string, Promise<string>>();

export interface InspectorApiClientOptions {
  baseUrl?: string;
}

type InspectorRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
  timeoutMs?: number;
};

export interface EnsureInspectorOptions extends InspectorApiClientOptions {
  openBrowser?: boolean;
  startIfNeeded?: boolean;
  tab?: string;
  timeoutMs?: number;
}

/**
 * Lightweight mirrors of the types in mcpjam-inspector/shared/inspector-command.ts.
 * The CLI only needs the HTTP-level request/response shapes, so we keep a slim
 * copy here rather than adding a cross-package dependency on @mcpjam/inspector.
 */
export interface InspectorCommandRequest {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

export interface InspectorCommandSuccessResponse {
  id: string;
  status: "success";
  result?: unknown;
}

export interface InspectorCommandErrorResponse {
  id: string;
  status: "error";
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type InspectorCommandResponse =
  | InspectorCommandSuccessResponse
  | InspectorCommandErrorResponse;

export function normalizeInspectorBaseUrl(baseUrl: string | undefined): string {
  const value =
    baseUrl?.trim() ||
    process.env.MCPJAM_INSPECTOR_URL?.trim() ||
    FALLBACK_INSPECTOR_BASE_URL;

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/$/, "");
  } catch (error) {
    throw operationalError(
      `Invalid Inspector URL "${value}".`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function buildInspectorUrl(baseUrl: string, tab?: string): string {
  if (!tab || !tab.trim()) {
    return baseUrl;
  }

  return `${baseUrl}/#${tab.trim()}`;
}

export function normalizeInspectorFrontendUrl(
  frontendUrl: unknown,
): string | undefined {
  if (typeof frontendUrl !== "string" || !frontendUrl.trim()) {
    return undefined;
  }

  try {
    const parsed = new URL(frontendUrl.trim());
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function buildInspectorBrowserUrl(
  baseUrl: string,
  frontendUrl?: string,
  tab?: string,
): string {
  return buildInspectorUrl(
    normalizeInspectorFrontendUrl(frontendUrl) ?? baseUrl,
    tab,
  );
}

export interface EnsureInspectorResult {
  baseUrl: string;
  frontendUrl?: string;
  url: string;
  started: boolean;
}

export async function ensureInspector(
  options: EnsureInspectorOptions = {},
): Promise<EnsureInspectorResult> {
  const baseUrl = normalizeInspectorBaseUrl(options.baseUrl);

  const health = await getInspectorHealth(baseUrl);
  if (health.healthy) {
    const url = buildInspectorBrowserUrl(baseUrl, health.frontendUrl, options.tab);
    if (options.openBrowser && !health.hasActiveClient) {
      openUrl(url);
    }
    return {
      baseUrl,
      ...(health.frontendUrl ? { frontendUrl: health.frontendUrl } : {}),
      url,
      started: false,
    };
  }

  if (!options.startIfNeeded) {
    throw operationalError(
      "Inspector is not running. Run `mcpjam inspector open` first or pass an Inspector-backed option that starts it.",
    );
  }

  await startInspector(baseUrl, options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  clearInspectorSessionTokenCache(baseUrl);

  const startedHealth = await getInspectorHealth(baseUrl);
  const url = buildInspectorBrowserUrl(
    baseUrl,
    startedHealth.frontendUrl,
    options.tab,
  );

  if (options.openBrowser) {
    openUrl(url);
  }

  return {
    baseUrl,
    ...(startedHealth.frontendUrl
      ? { frontendUrl: startedHealth.frontendUrl }
      : {}),
    url,
    started: true,
  };
}

export async function stopInspector(
  baseUrl: string,
): Promise<{ stopped: boolean; baseUrl: string }> {
  const normalized = normalizeInspectorBaseUrl(baseUrl);

  if (!(await isInspectorHealthy(normalized))) {
    return { stopped: false, baseUrl: normalized };
  }

  const fetchShutdown = async (): Promise<Response> => {
    const token = await fetchInspectorSessionToken(normalized);
    return await fetch(`${normalized}/api/shutdown`, {
      method: "POST",
      headers: {
        "X-MCP-Session-Auth": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(STOP_FETCH_TIMEOUT_MS),
    });
  };

  try {
    let response = await fetchShutdown();
    if (isAuthFailure(response)) {
      clearInspectorSessionTokenCache(normalized);
      response = await fetchShutdown();
    }
    if (response.ok) {
      clearInspectorSessionTokenCache(normalized);
    }
    return { stopped: response.ok, baseUrl: normalized };
  } catch {
    return { stopped: false, baseUrl: normalized };
  }
}

export class InspectorApiClient {
  readonly baseUrl: string;

  constructor(options: InspectorApiClientOptions = {}) {
    this.baseUrl = normalizeInspectorBaseUrl(options.baseUrl);
  }

  async ensure(options: Omit<EnsureInspectorOptions, "baseUrl"> = {}) {
    return ensureInspector({ ...options, baseUrl: this.baseUrl });
  }

  async connectServer(
    serverId: string,
    serverConfig: unknown,
    options: { timeoutMs?: number } = {},
  ) {
    return this.request("/api/mcp/connect", {
      method: "POST",
      body: { serverId, serverConfig },
      timeoutMs: options.timeoutMs,
    });
  }

  async listServers() {
    return this.request("/api/mcp/servers");
  }

  async getServerStatus(serverId: string) {
    return this.request(
      `/api/mcp/servers/status/${encodeURIComponent(serverId)}`,
    );
  }

  async getInitInfo(serverId: string) {
    return this.request(
      `/api/mcp/servers/init-info/${encodeURIComponent(serverId)}`,
    );
  }

  async listTools(
    serverId: string,
    options: { modelId?: string; cursor?: string } = {},
  ) {
    return this.request("/api/mcp/tools/list", {
      method: "POST",
      body: { serverId, ...options },
    });
  }

  async executeTool(
    serverId: string,
    toolName: string,
    parameters: Record<string, unknown> = {},
  ) {
    return this.request("/api/mcp/tools/execute", {
      method: "POST",
      body: { serverId, toolName, parameters },
    });
  }

  async respondToElicitation(
    executionId: string,
    requestId: string,
    response: unknown,
  ) {
    return this.request("/api/mcp/tools/respond", {
      method: "POST",
      body: { executionId, requestId, response },
    });
  }

  async executeCommand(
    request: InspectorCommandRequest,
  ): Promise<InspectorCommandResponse> {
    const commandTimeoutMs =
      typeof request.timeoutMs === "number" && request.timeoutMs > 0
        ? request.timeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS;
    const fetchCommand = async (): Promise<Response> => {
      const token = await fetchInspectorSessionToken(this.baseUrl);
      return await fetch(`${this.baseUrl}/api/mcp/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(
          commandTimeoutMs + COMMAND_FETCH_TIMEOUT_BUFFER_MS,
        ),
      });
    };

    let response: Response;
    try {
      response = await fetchCommand();
      if (isAuthFailure(response)) {
        clearInspectorSessionTokenCache(this.baseUrl);
        response = await fetchCommand();
      }
    } catch (error) {
      throw operationalError(
        `Failed to contact Inspector at ${this.baseUrl}.`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (isAuthFailure(response)) {
      throw operationalError(
        `Inspector command request failed authentication with ${response.status}.`,
      );
    }

    const payload = await readResponsePayload(response);
    if (isInspectorCommandResponse(payload)) {
      return payload;
    }

    if (!response.ok) {
      throw operationalError(
        getErrorMessage(payload) ??
          `Inspector command request failed with ${response.status}.`,
        payload,
      );
    }

    throw operationalError("Inspector command response was invalid.", payload);
  }

  async request(
    path: string,
    init: InspectorRequestInit = {},
  ): Promise<unknown> {
    const fetchRequest = async (): Promise<Response> => {
      const token = await fetchInspectorSessionToken(this.baseUrl);
      const { body: initBody, timeoutMs, ...fetchInit } = init;
      const headers = new Headers(fetchInit.headers);
      headers.set("X-MCP-Session-Auth", `Bearer ${token}`);

      let body: BodyInit | undefined;
      if (initBody !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(initBody);
      }

      return await fetch(`${this.baseUrl}${path}`, {
        ...fetchInit,
        signal:
          fetchInit.signal ??
          AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        headers,
        body,
      });
    };

    let response: Response;
    try {
      response = await fetchRequest();
      if (isAuthFailure(response)) {
        clearInspectorSessionTokenCache(this.baseUrl);
        response = await fetchRequest();
      }
    } catch (error) {
      throw operationalError(
        `Failed to contact Inspector at ${this.baseUrl}.`,
        error instanceof Error ? error.message : String(error),
      );
    }

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw operationalError(
        getErrorMessage(payload) ??
          `Inspector request ${path} failed with ${response.status}.`,
        payload,
      );
    }

    return payload;
  }
}

export async function fetchInspectorSessionToken(
  baseUrl: string,
): Promise<string> {
  const normalizedBaseUrl = normalizeInspectorBaseUrl(baseUrl);
  const cached = tokenCache.get(normalizedBaseUrl);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.token;
  }

  const pending = tokenRequests.get(normalizedBaseUrl);
  if (pending) {
    return pending;
  }

  const request = fetchFreshInspectorSessionToken(normalizedBaseUrl).finally(
    () => {
      tokenRequests.delete(normalizedBaseUrl);
    },
  );
  tokenRequests.set(normalizedBaseUrl, request);
  return request;
}

export function clearInspectorSessionTokenCache(baseUrl?: string): void {
  if (!baseUrl) {
    tokenCache.clear();
    tokenRequests.clear();
    return;
  }

  const normalizedBaseUrl = normalizeInspectorBaseUrl(baseUrl);
  tokenCache.delete(normalizedBaseUrl);
  tokenRequests.delete(normalizedBaseUrl);
}

async function fetchFreshInspectorSessionToken(
  normalizedBaseUrl: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${normalizedBaseUrl}/api/session-token`, {
      signal: AbortSignal.timeout(SESSION_TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw operationalError(
      "Failed to contact the local Inspector session-token endpoint.",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    throw operationalError(
      `Inspector session-token request failed with ${response.status}.`,
    );
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw operationalError("Inspector session-token response was invalid.");
  }

  tokenCache.set(normalizedBaseUrl, {
    token: body.token,
    fetchedAt: Date.now(),
  });
  return body.token;
}

function getInspectorStartScriptPath(): string {
  return fileURLToPath(
    new URL("../../../mcpjam-inspector/bin/start.js", import.meta.url),
  );
}

interface InspectorHealthStatus {
  healthy: boolean;
  hasActiveClient: boolean;
  frontendUrl?: string;
}

async function getInspectorHealth(
  baseUrl: string,
  timeoutMs = HEALTH_FETCH_TIMEOUT_MS,
): Promise<InspectorHealthStatus> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { healthy: false, hasActiveClient: false };
    }
    const body = (await response.json()) as {
      hasActiveClient?: boolean;
      frontend?: unknown;
    };
    const frontendUrl = normalizeInspectorFrontendUrl(body.frontend);
    return {
      healthy: true,
      hasActiveClient: body.hasActiveClient === true,
      ...(frontendUrl ? { frontendUrl } : {}),
    };
  } catch {
    return { healthy: false, hasActiveClient: false };
  }
}

async function isInspectorHealthy(baseUrl: string): Promise<boolean> {
  const status = await getInspectorHealth(baseUrl);
  return status.healthy;
}

export function getNpxExecutable(platform = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
}

async function startInspector(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const parsedUrl = new URL(baseUrl);
  const port = parsedUrl.port || "6274";
  const startScriptPath = getInspectorStartScriptPath();
  const hasStartScript = existsSync(startScriptPath);
  const args = hasStartScript
    ? [startScriptPath, "--port", port, "--no-open"]
    : ["-y", "@mcpjam/inspector@latest", "--port", port, "--no-open"];
  const executable = hasStartScript ? process.execPath : getNpxExecutable();
  const logPath = getInspectorStartupLogPath();
  const logFd = openStartupLogFile(logPath);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, args, {
      cwd: hasStartScript ? path.dirname(startScriptPath) : process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        HOST: parsedUrl.hostname,
        MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
      },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isInspectorHealthy(baseUrl)) {
      return;
    }
    await delay(250);
  }

  throw operationalError(
    `Inspector did not become ready within ${timeoutMs}ms. Startup log: ${logPath}`,
  );
}

function isAuthFailure(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function getInspectorStartupLogPath(): string {
  return path.join(os.tmpdir(), "mcpjam-inspector-startup.log");
}

function openStartupLogFile(logPath: string): number {
  try {
    if (existsSync(logPath) && statSync(logPath).size > STARTUP_LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Startup logging is best-effort; rotation failures should not block launch.
  }

  return openSync(logPath, "a");
}

function openUrl(url: string): void {
  if (process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN === "1") {
    return;
  }

  const platform = process.platform;
  const child =
    platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
        })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return typeof payload === "string" ? payload : undefined;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") {
    return record.error;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return undefined;
}

function isInspectorCommandResponse(
  value: unknown,
): value is InspectorCommandResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") {
    return false;
  }

  if (record.status === "success") {
    return true;
  }

  if (record.status !== "error") {
    return false;
  }

  const error = record.error;
  return Boolean(
    error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).code === "string" &&
      typeof (error as Record<string, unknown>).message === "string",
  );
}
