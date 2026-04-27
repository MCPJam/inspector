import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operationalError } from "./output.js";

const DEFAULT_INSPECTOR_BASE_URL =
  process.env.MCPJAM_INSPECTOR_URL ?? "http://127.0.0.1:6274";
const DEFAULT_START_TIMEOUT_MS = 30_000;

const TOKEN_TTL_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; fetchedAt: number }>();

export interface InspectorApiClientOptions {
  baseUrl?: string;
}

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
  const value = baseUrl?.trim() || DEFAULT_INSPECTOR_BASE_URL;

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

export async function ensureInspector(
  options: EnsureInspectorOptions = {},
): Promise<{ baseUrl: string; started: boolean }> {
  const baseUrl = normalizeInspectorBaseUrl(options.baseUrl);

  const health = await getInspectorHealth(baseUrl);
  if (health.healthy) {
    if (options.openBrowser && !health.hasActiveClient) {
      openUrl(buildInspectorUrl(baseUrl, options.tab));
    }
    return { baseUrl, started: false };
  }

  if (!options.startIfNeeded) {
    throw operationalError(
      "Inspector is not running. Run `mcpjam inspector open` first or pass an Inspector-backed option that starts it.",
    );
  }

  await startInspector(baseUrl, options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);

  if (options.openBrowser) {
    openUrl(buildInspectorUrl(baseUrl, options.tab));
  }

  return { baseUrl, started: true };
}

export async function stopInspector(
  baseUrl: string,
): Promise<{ stopped: boolean; baseUrl: string }> {
  const normalized = normalizeInspectorBaseUrl(baseUrl);

  if (!(await isInspectorHealthy(normalized))) {
    return { stopped: false, baseUrl: normalized };
  }

  try {
    const response = await fetch(`${normalized}/api/shutdown`, {
      method: "POST",
    });
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

  async connectServer(serverId: string, serverConfig: unknown) {
    return this.request("/api/mcp/connect", {
      method: "POST",
      body: { serverId, serverConfig },
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
    const token = await fetchInspectorSessionToken(this.baseUrl);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/mcp/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw operationalError(
        `Failed to contact Inspector at ${this.baseUrl}.`,
        error instanceof Error ? error.message : String(error),
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
    init: Omit<RequestInit, "body"> & { body?: unknown } = {},
  ): Promise<unknown> {
    const token = await fetchInspectorSessionToken(this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("X-MCP-Session-Auth", `Bearer ${token}`);

    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        body,
      });
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

  let response: Response;
  try {
    response = await fetch(`${normalizedBaseUrl}/api/session-token`);
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

  tokenCache.set(normalizedBaseUrl, { token: body.token, fetchedAt: Date.now() });
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
}

async function getInspectorHealth(
  baseUrl: string,
): Promise<InspectorHealthStatus> {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) {
      return { healthy: false, hasActiveClient: false };
    }
    const body = (await response.json()) as { hasActiveClient?: boolean };
    return {
      healthy: true,
      hasActiveClient: body.hasActiveClient === true,
    };
  } catch {
    return { healthy: false, hasActiveClient: false };
  }
}

async function isInspectorHealthy(baseUrl: string): Promise<boolean> {
  const status = await getInspectorHealth(baseUrl);
  return status.healthy;
}

async function startInspector(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const parsedUrl = new URL(baseUrl);
  const port = parsedUrl.port || "6274";
  const startScriptPath = getInspectorStartScriptPath();
  const args = existsSync(startScriptPath)
    ? [startScriptPath, "--port", port]
    : ["-y", "@mcpjam/inspector@latest", "--port", port];
  const executable = existsSync(startScriptPath) ? process.execPath : "npx";

  const child = spawn(executable, args, {
    cwd: existsSync(startScriptPath)
      ? path.dirname(startScriptPath)
      : process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOST: parsedUrl.hostname,
    },
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isInspectorHealthy(baseUrl)) {
      return;
    }
    await delay(250);
  }

  throw operationalError(
    `Inspector did not become ready within ${timeoutMs}ms.`,
  );
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
