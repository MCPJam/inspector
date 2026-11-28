import type { InspectorProjectTarget } from "./inspector-project-target.js";
import { createRequire } from "node:module";
import path from "node:path";
import {
  clearInspectorSessionTokenCache as clearInspectorSessionTokenCacheWithEngine,
  ensureInspector as ensureInspectorWithEngine,
  ensureInspectorBackend as ensureInspectorBackendWithEngine,
  fetchInspectorSessionToken as fetchInspectorSessionTokenWithEngine,
  isAuthFailure,
  isInspectorError,
  normalizeInspectorBaseUrl as normalizeInspectorBaseUrlWithEngine,
  resolveInspectorBrowserBaseUrl as resolveInspectorBrowserBaseUrlWithEngine,
  stopInspector as stopInspectorWithEngine,
  type EnsureInspectorBackendOptions,
  type EnsureInspectorBackendResult,
  type EnsureInspectorOptions,
  type EnsureInspectorResult,
} from "@mcpjam/sdk/internal/inspector";
import { operationalError } from "./output.js";

export {
  buildInspectorAccessUrl,
  buildInspectorBrowserUrl,
  delay,
  getNpxExecutable,
  normalizeInspectorFrontendUrl,
} from "@mcpjam/sdk/internal/inspector";

const require = createRequire(import.meta.url);

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const COMMAND_FETCH_TIMEOUT_BUFFER_MS = 2_000;

export interface InspectorApiClientOptions {
  baseUrl?: string;
}

type InspectorRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
  timeoutMs?: number;
  /** Scoped operations may execute a tool before returning an auth failure. */
  retrySessionAuth?: boolean;
  /**
   * Return this non-2xx body instead of throwing, when the caller can read it.
   *
   * Some endpoints answer a STRUCTURED OUTCOME with a 4xx or 5xx — the browser
   * door replies 403 for a refused command and 502 for one whose result is
   * unknown, and those bodies carry the very distinction a caller has to act
   * on. Throwing them away as generic transport failures loses it: `refused`
   * (nothing ran, retry is safe) and `unknown` (it may have run, do NOT retry)
   * become the same thrown error, and a script retries a command that already
   * happened.
   *
   * The predicate keeps that knowledge with the caller who has it. Anything it
   * does not claim still throws, so a consent failure or a usage error stays
   * loud instead of arriving as a quiet object.
   */
  treatAsSuccess?: (status: number, payload: unknown) => boolean;
};

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

/**
 * The start-or-attach engine lives in `@mcpjam/sdk/internal/inspector` and
 * throws its own `InspectorError`. These wrappers turn that back into the
 * CLI's operational error, so exit codes and structured output stay the same,
 * and give the engine the CLI's local `@mcpjam/inspector` start script.
 */
function toCliError(error: unknown): unknown {
  return isInspectorError(error)
    ? operationalError(error.message, error.details)
    : error;
}

export function normalizeInspectorBaseUrl(baseUrl: string | undefined): string {
  try {
    return normalizeInspectorBaseUrlWithEngine(baseUrl);
  } catch (error) {
    throw toCliError(error);
  }
}

export async function resolveInspectorBrowserBaseUrl(
  baseUrl: string,
  frontendUrl?: string,
  options: { skipDiscovery?: boolean } = {},
): Promise<string> {
  try {
    return await resolveInspectorBrowserBaseUrlWithEngine(
      baseUrl,
      frontendUrl,
      options,
    );
  } catch (error) {
    throw toCliError(error);
  }
}

export async function ensureInspector(
  options: EnsureInspectorOptions = {},
): Promise<EnsureInspectorResult> {
  try {
    return await ensureInspectorWithEngine({
      ...options,
      resolveStartScriptPath: getInspectorStartScriptPath,
    });
  } catch (error) {
    throw toCliError(error);
  }
}

export async function ensureInspectorBackend(
  options: EnsureInspectorBackendOptions = {},
): Promise<EnsureInspectorBackendResult> {
  try {
    return await ensureInspectorBackendWithEngine({
      ...options,
      resolveStartScriptPath: getInspectorStartScriptPath,
    });
  } catch (error) {
    throw toCliError(error);
  }
}

export async function stopInspector(
  baseUrl: string,
): Promise<{ stopped: boolean; baseUrl: string }> {
  try {
    return await stopInspectorWithEngine(baseUrl);
  } catch (error) {
    throw toCliError(error);
  }
}

export async function fetchInspectorSessionToken(
  baseUrl: string,
): Promise<string> {
  try {
    return await fetchInspectorSessionTokenWithEngine(baseUrl);
  } catch (error) {
    throw toCliError(error);
  }
}

export function clearInspectorSessionTokenCache(baseUrl?: string): void {
  try {
    clearInspectorSessionTokenCacheWithEngine(baseUrl);
  } catch (error) {
    throw toCliError(error);
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

  async ensureBackend(
    options: Omit<EnsureInspectorBackendOptions, "baseUrl"> = {},
  ) {
    return ensureInspectorBackend({ ...options, baseUrl: this.baseUrl });
  }

  async connectServer(
    serverId: string,
    serverConfig: unknown,
    options: { timeoutMs?: number; target?: InspectorProjectTarget } = {},
  ) {
    const target = options.target;
    try {
      return await this.request("/api/mcp/connect", {
        method: "POST",
        body: target
          ? {
              projectId: target.projectId,
              serverId: target.serverId,
              serverName: target.serverName,
            }
          : { serverId, serverConfig },
        ...(target
          ? { headers: { Authorization: `Bearer ${target.accessToken}` } }
          : {}),
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if (
        !target &&
        error instanceof Error &&
        error.message.includes("projectId is required")
      ) {
        throw operationalError(
          "This Inspector requires a saved project server. Use --server-id <id> with --project <id-or-name>. Add ad-hoc configurations in Inspector first.",
        );
      }
      throw error;
    }
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
      const { body: initBody, timeoutMs, retrySessionAuth: _retrySessionAuth, ...fetchInit } = init;
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
      if (init.retrySessionAuth !== false && isAuthFailure(response)) {
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
    if (!response.ok && !init.treatAsSuccess?.(response.status, payload)) {
      throw operationalError(
        getErrorMessage(payload) ??
          `Inspector request ${path} failed with ${response.status}.`,
        payload,
      );
    }

    return payload;
  }
}

function getInspectorStartScriptPath(): string | undefined {
  try {
    const packageJsonPath = require.resolve("@mcpjam/inspector/package.json");
    return path.resolve(path.dirname(packageJsonPath), "bin/start.js");
  } catch {
    return undefined;
  }
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
