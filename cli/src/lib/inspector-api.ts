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
const FRONTEND_PROBE_TIMEOUT_MS = 750;
const ORIGIN_PROBE_TIMEOUT_MS = 750;
const SESSION_TOKEN_TIMEOUT_MS = 3_000;
const STOP_FETCH_TIMEOUT_MS = 3_000;
const STARTUP_LOG_MAX_BYTES = 1024 * 1024;
const FRONTEND_PORT_SCAN_WINDOW = 10;
const WELL_KNOWN_FRONTEND_PORTS = [5173, 5174, 5175, 8080];

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
  frontendUrl?: string;
  openBrowser?: boolean;
  skipDiscovery?: boolean;
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

function normalizeExplicitInspectorFrontendUrl(frontendUrl: string): string {
  const normalized = normalizeInspectorFrontendUrl(frontendUrl);
  if (!normalized) {
    throw operationalError(`Invalid Inspector frontend URL "${frontendUrl}".`);
  }
  return normalized;
}

function canonicalizeInspectorFrontendUrl(
  baseUrl: string,
  frontendUrl: string | undefined,
): string | undefined {
  if (!frontendUrl) {
    return undefined;
  }

  try {
    const base = new URL(baseUrl);
    const frontend = new URL(frontendUrl);
    if (
      isLoopbackHostname(base.hostname) &&
      isLoopbackHostname(frontend.hostname) &&
      base.protocol === frontend.protocol &&
      getEffectiveUrlPort(base) === getEffectiveUrlPort(frontend)
    ) {
      return baseUrl;
    }
  } catch {
    return frontendUrl;
  }

  return frontendUrl;
}

function getEffectiveUrlPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

export function buildInspectorBrowserUrl(
  baseUrl: string,
  frontendUrl?: string,
  tab?: string,
): string {
  return buildInspectorUrl(
    canonicalizeInspectorFrontendUrl(
      baseUrl,
      normalizeInspectorFrontendUrl(frontendUrl),
    ) ?? baseUrl,
    tab,
  );
}

export async function resolveInspectorBrowserBaseUrl(
  baseUrl: string,
  frontendUrl?: string,
  options: { skipDiscovery?: boolean } = {},
): Promise<string> {
  const fastResolution = await resolveInspectorBrowserBaseUrlFast(
    baseUrl,
    frontendUrl,
  );
  if (fastResolution.browserBaseUrl) {
    return fastResolution.browserBaseUrl;
  }

  if (options.skipDiscovery) {
    assertFastFrontendMismatch(fastResolution.candidates);
    return fastResolution.normalizedFrontendUrl ?? baseUrl;
  }

  const discoveredCandidates = await discoverLocalInspectorFrontendCandidates(
    baseUrl,
    fastResolution.normalizedFrontendUrl,
  );

  const usableDiscoveredCandidate = discoveredCandidates.find(
    isUsableInspectorFrontendCandidate,
  );
  if (usableDiscoveredCandidate) {
    return usableDiscoveredCandidate.url;
  }

  const candidates = [...fastResolution.candidates, ...discoveredCandidates];
  assertFullFrontendMismatch(candidates);

  return fastResolution.normalizedFrontendUrl ?? baseUrl;
}

interface InspectorBrowserBaseUrlFastResolution {
  browserBaseUrl?: string;
  candidates: InspectorFrontendCandidate[];
  normalizedFrontendUrl?: string;
}

async function resolveInspectorBrowserBaseUrlFast(
  baseUrl: string,
  frontendUrl?: string,
): Promise<InspectorBrowserBaseUrlFastResolution> {
  const normalizedFrontendUrl = canonicalizeInspectorFrontendUrl(
    baseUrl,
    normalizeInspectorFrontendUrl(frontendUrl),
  );
  const targets: Array<{
    source: InspectorFrontendCandidate["source"];
    url: string;
  }> = [];

  if (normalizedFrontendUrl) {
    targets.push({ source: "advertised", url: normalizedFrontendUrl });
  }
  if (!targets.some((target) => target.url === baseUrl)) {
    targets.push({ source: "base", url: baseUrl });
  }

  const candidates = await inspectInspectorFrontendCandidates(
    baseUrl,
    targets,
  );
  const usableCandidate = candidates.find(isUsableInspectorFrontendCandidate);

  return {
    ...(usableCandidate
      ? { browserBaseUrl: usableCandidate.url }
      : {}),
    candidates,
    ...(normalizedFrontendUrl ? { normalizedFrontendUrl } : {}),
  };
}

async function inspectInspectorFrontendCandidates(
  apiBaseUrl: string,
  targets: ReadonlyArray<{
    source: InspectorFrontendCandidate["source"];
    url: string;
  }>,
): Promise<InspectorFrontendCandidate[]> {
  const settled = await Promise.allSettled(
    targets.map((target) =>
      inspectInspectorFrontendCandidate(apiBaseUrl, target.url, target.source),
    ),
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const target = targets[index]!;
    return {
      isFrontend: false,
      originStatus: "unknown",
      source: target.source,
      url: target.url,
    };
  });
}

function assertFastFrontendMismatch(
  candidates: InspectorFrontendCandidate[],
): void {
  const advertisedCandidate = candidates.find(
    (candidate) => candidate.source === "advertised",
  );
  const rejectedLiveCandidate = candidates.find(
    (candidate) => candidate.isFrontend && candidate.originStatus === "rejected",
  );

  if (!rejectedLiveCandidate) {
    return;
  }

  if (advertisedCandidate === rejectedLiveCandidate) {
    throw frontendMismatchError(undefined, rejectedLiveCandidate);
  }
  throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
}

function assertFullFrontendMismatch(
  candidates: InspectorFrontendCandidate[],
): void {
  const advertisedCandidate = candidates.find(
    (candidate) => candidate.source === "advertised",
  );
  const rejectedLiveCandidate = candidates.find(
    (candidate) =>
      candidate !== advertisedCandidate &&
      candidate.isFrontend &&
      candidate.originStatus === "rejected",
  );

  if (
    advertisedCandidate?.isFrontend &&
    advertisedCandidate.originStatus === "rejected"
  ) {
    throw frontendMismatchError(undefined, advertisedCandidate);
  }

  if (
    advertisedCandidate &&
    !advertisedCandidate.isFrontend &&
    advertisedCandidate.originStatus === "accepted"
  ) {
    throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
  }

  if (rejectedLiveCandidate) {
    throw frontendMismatchError(advertisedCandidate, rejectedLiveCandidate);
  }
}

async function resolveInspectorBrowserBaseUrlForHealth(
  baseUrl: string,
  frontendUrl: string | undefined,
  options: {
    hasActiveClient: boolean;
    openBrowser: boolean;
    skipDiscovery?: boolean;
  },
): Promise<string> {
  try {
    return await resolveInspectorBrowserBaseUrl(baseUrl, frontendUrl, {
      skipDiscovery: options.skipDiscovery,
    });
  } catch (error) {
    if (options.hasActiveClient && !options.openBrowser) {
      return (
        canonicalizeInspectorFrontendUrl(
          baseUrl,
          normalizeInspectorFrontendUrl(frontendUrl),
        ) ?? baseUrl
      );
    }
    throw error;
  }
}

export interface EnsureInspectorResult {
  baseUrl: string;
  frontendUrl?: string;
  hasActiveClient: boolean;
  url: string;
  started: boolean;
}

export async function ensureInspector(
  options: EnsureInspectorOptions = {},
): Promise<EnsureInspectorResult> {
  const baseUrl = normalizeInspectorBaseUrl(options.baseUrl);
  const explicitFrontendUrl =
    options.frontendUrl !== undefined
      ? normalizeExplicitInspectorFrontendUrl(options.frontendUrl)
      : undefined;

  const health = await getInspectorHealth(baseUrl);
  if (health.healthy) {
    const browserBaseUrl =
      explicitFrontendUrl ??
      (await resolveInspectorBrowserBaseUrlForHealth(baseUrl, health.frontendUrl, {
        hasActiveClient: health.hasActiveClient,
        openBrowser: options.openBrowser === true,
        skipDiscovery: options.skipDiscovery,
      }));
    const url = buildInspectorUrl(browserBaseUrl, options.tab);
    if (options.openBrowser && !health.hasActiveClient) {
      openUrl(url);
    }
    return {
      baseUrl,
      ...(browserBaseUrl !== baseUrl ? { frontendUrl: browserBaseUrl } : {}),
      hasActiveClient: health.hasActiveClient,
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
  const browserBaseUrl =
    explicitFrontendUrl ??
    (await resolveInspectorBrowserBaseUrlForHealth(
      baseUrl,
      startedHealth.frontendUrl,
      {
        hasActiveClient: startedHealth.hasActiveClient,
        openBrowser: options.openBrowser === true,
        skipDiscovery: options.skipDiscovery,
      },
    ));
  const url = buildInspectorUrl(browserBaseUrl, options.tab);

  if (options.openBrowser) {
    openUrl(url);
  }

  return {
    baseUrl,
    ...(browserBaseUrl !== baseUrl ? { frontendUrl: browserBaseUrl } : {}),
    hasActiveClient: startedHealth.hasActiveClient,
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

type InspectorOriginStatus = "accepted" | "rejected" | "unknown";

interface InspectorFrontendCandidate {
  isFrontend: boolean;
  originStatus: InspectorOriginStatus;
  source: "advertised" | "base" | "discovered";
  url: string;
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

async function isInspectorFrontendUrl(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(FRONTEND_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      return false;
    }

    const body = await response.text();
    return (
      hasInspectorFrontendMarker(body) ||
      /<title>\s*MCPJam Inspector\s*<\/title>/i.test(body) ||
      body.includes("/mcp_jam.svg") ||
      body.includes("__MCP_SESSION_TOKEN__")
    );
  } catch {
    return false;
  }
}

function hasInspectorFrontendMarker(body: string): boolean {
  return /<meta\b(?=[^>]*\bname=["']mcpjam-inspector["'])[^>]*>/i.test(body);
}

async function inspectInspectorFrontendCandidate(
  apiBaseUrl: string,
  frontendBaseUrl: string,
  source: InspectorFrontendCandidate["source"],
): Promise<InspectorFrontendCandidate> {
  const [isFrontend, originStatus] = await Promise.all([
    isInspectorFrontendUrl(frontendBaseUrl),
    getInspectorApiOriginStatus(apiBaseUrl, frontendBaseUrl),
  ]);

  return {
    isFrontend,
    originStatus,
    source,
    url: frontendBaseUrl,
  };
}

function isUsableInspectorFrontendCandidate(
  candidate: InspectorFrontendCandidate,
): boolean {
  return candidate.isFrontend && candidate.originStatus !== "rejected";
}

async function getInspectorApiOriginStatus(
  apiBaseUrl: string,
  frontendBaseUrl: string,
): Promise<InspectorOriginStatus> {
  try {
    const origin = new URL(frontendBaseUrl).origin;
    const response = await fetch(`${apiBaseUrl}/api/session-token`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(ORIGIN_PROBE_TIMEOUT_MS),
    });
    return response.status === 403 ? "rejected" : "accepted";
  } catch {
    return "unknown";
  }
}

function frontendMismatchError(
  advertisedCandidate: InspectorFrontendCandidate | undefined,
  rejectedLiveCandidate: InspectorFrontendCandidate | undefined,
) {
  const details = {
    ...(advertisedCandidate
      ? {
          advertisedFrontendUrl: advertisedCandidate.url,
          advertisedFrontendReachable: advertisedCandidate.isFrontend,
          advertisedOriginStatus: advertisedCandidate.originStatus,
        }
      : {}),
    ...(rejectedLiveCandidate
      ? {
          rejectedFrontendUrl: rejectedLiveCandidate.url,
          rejectedOriginStatus: rejectedLiveCandidate.originStatus,
        }
      : {}),
  };

  if (advertisedCandidate && rejectedLiveCandidate) {
    return operationalError(
      `Inspector backend advertises ${advertisedCandidate.url}, but no Inspector frontend responded there. A frontend was found at ${rejectedLiveCandidate.url}, but the Inspector backend rejects that origin. Start Inspector's frontend on the advertised URL or restart Inspector with matching frontend/backend ports.`,
      details,
    );
  }

  if (advertisedCandidate) {
    return operationalError(
      `Inspector backend advertises ${advertisedCandidate.url}, but no Inspector frontend responded there. Start Inspector's frontend on the advertised URL or restart Inspector with matching frontend/backend ports.`,
      details,
    );
  }

  return operationalError(
    `Inspector frontend ${
      rejectedLiveCandidate?.url ?? "URL"
    } is reachable, but the Inspector backend rejects that origin. Restart Inspector with matching frontend/backend ports.`,
    details,
  );
}

async function discoverLocalInspectorFrontendCandidates(
  baseUrl: string,
  frontendUrl?: string,
): Promise<InspectorFrontendCandidate[]> {
  const hosts = getLocalInspectorCandidateHosts(baseUrl, frontendUrl);
  if (hosts.length === 0) {
    return [];
  }

  const protocol =
    getUrlProtocol(frontendUrl) ?? getUrlProtocol(baseUrl) ?? "http:";
  const targets: string[] = [];
  for (const port of getFrontendProbePorts(frontendUrl)) {
    for (const host of hosts) {
      const candidate = `${protocol}//${formatUrlHostname(host)}:${port}`;
      if (candidate === frontendUrl || candidate === baseUrl) {
        continue;
      }
      targets.push(candidate);
    }
  }

  const inspectedCandidates = await inspectInspectorFrontendCandidates(
    baseUrl,
    targets.map((candidate) => ({
      source: "discovered" as const,
      url: candidate,
    })),
  );
  return inspectedCandidates.filter((candidate) => candidate.isFrontend);
}

function getLocalInspectorCandidateHosts(
  baseUrl: string,
  frontendUrl?: string,
): string[] {
  const hosts = new Set<string>();
  for (const value of [frontendUrl, baseUrl]) {
    const hostname = getUrlHostname(value);
    if (!hostname || !isLoopbackHostname(hostname)) {
      continue;
    }
    hosts.add(hostname);
    if (hostname === "localhost") {
      hosts.add("127.0.0.1");
    }
    if (hostname === "127.0.0.1") {
      hosts.add("localhost");
    }
  }
  return [...hosts];
}

function getFrontendProbePorts(frontendUrl?: string): number[] {
  const ports = new Set<number>();
  const hintedPort = getUrlPort(frontendUrl);
  if (hintedPort) {
    ports.add(hintedPort);
    for (let offset = 1; offset <= FRONTEND_PORT_SCAN_WINDOW; offset += 1) {
      ports.add(hintedPort + offset);
    }
  }
  for (const port of WELL_KNOWN_FRONTEND_PORTS) {
    ports.add(port);
  }
  return [...ports].filter((port) => port > 0 && port < 65_536);
}

function getUrlHostname(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function getUrlProtocol(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

function getUrlPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function formatUrlHostname(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
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
