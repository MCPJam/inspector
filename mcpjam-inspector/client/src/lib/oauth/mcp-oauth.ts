/**
 * Production OAuth implementation using the SDK state-machine runner with trace support.
 */

import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  fetchToken,
  getBrowserDebugDynamicRegistrationMetadata,
  EMPTY_OAUTH_FLOW_STATE,
  projectOAuthTraceSnapshot,
  resolveAuthorizationPlan,
  runOAuthStateMachine,
  selectResourceURL,
} from "@mcpjam/sdk/browser";
import type {
  AuthorizationDiscoverySnapshot,
  OAuthProtocolMode,
  OAuthRegistrationMode,
  HttpHistoryEntry,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthFlowState,
  OAuthProtocolVersion,
  OAuthRequestResult,
  ResolvedAuthorizationPlan,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
  OAuthTraceSnapshot,
} from "@mcpjam/sdk/browser";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import { generateRandomString } from "./pkce";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE, SANITIZE_OAUTH_TRACES } from "@/lib/config";
import { captureServerDetailModalOAuthResume } from "@/lib/server-detail-modal-resume";
import {
  matchesHostedOAuthServerIdentity,
  readHostedOAuthPendingMarker,
  writeHostedOAuthPendingMarker,
  type HostedOAuthCallbackContext,
} from "@/lib/hosted-oauth-callback";
import { getRedirectUri } from "./constants";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import {
  appendOAuthTraceHttpHistory,
  buildOAuthTraceFromSnapshot,
  clearOAuthTrace,
  completeOAuthTraceStep,
  createOAuthTrace,
  failOAuthTraceStep,
  loadOAuthTrace,
  mergeOAuthTraces,
  startOAuthTraceStep,
  type OAuthTrace,
} from "./oauth-trace";

// Store original fetch for restoration
const originalFetch = window.fetch;

interface StoredOAuthDiscoveryState {
  serverUrl: string;
  discoveryState: OAuthDiscoveryState;
}

interface StoredOAuthClientInformation {
  client_id?: string;
  client_secret?: string;
}

type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export interface StoredOAuthConfig {
  scopes?: string[];
  customHeaders?: Record<string, string>;
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
  protocolMode?: OAuthProtocolMode;
  protocolVersion?: OAuthProtocolVersion;
  registrationMode?: OAuthRegistrationMode;
  registrationStrategy?: OAuthRegistrationStrategy;
}

interface OAuthRoutingConfig {
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
}

interface StoredOAuthFlowSession {
  version: 1;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  state: OAuthFlowState;
}

function getFlowStateStorageKey(serverName: string): string {
  return `mcp-oauth-flow-state-${serverName}`;
}

function getDiscoveryStorageKey(serverName: string): string {
  return `mcp-discovery-${serverName}`;
}

function clearStoredDiscoveryState(serverName: string): void {
  localStorage.removeItem(getDiscoveryStorageKey(serverName));
}

type OAuthRequestFields = Record<string, string>;

const SENSITIVE_FIELD_NAMES = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code",
  "code_verifier",
  "authorization_code",
  "authorization",
  "state",
  "cookie",
  "set_cookie",
  "api_key",
]);

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^api-key$/i,
  /^apikey$/i,
  /^x-auth-token$/i,
  /^x-csrf-token$/i,
  /^x-session-token$/i,
  /^x-access-token$/i,
  /^x-refresh-token$/i,
  /^x-client-secret$/i,
  /^x-credential$/i,
];

function normalizeSensitiveKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveTraceFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normalizeSensitiveKey(key));
}

function isSensitiveHeaderName(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key)) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized
    ) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
}

function isSensitiveQueryParamName(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    /(^|_)(token|secret|password|credential|cookie|auth)(_|$)/.test(
      normalized
    ) ||
    /(^|_)api_?key(_|$)/.test(normalized)
  );
}

function redactSensitiveValue(value: unknown): string {
  if (typeof value !== "string") {
    return "[redacted]";
  }

  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 4)}...[redacted]...${value.slice(-2)}`;
}

function sanitizeOAuthTraceString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeOAuthUrl(trimmed);
  }

  const looksStructured =
    trimmed.includes("=") ||
    trimmed.includes("&") ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksStructured) {
    const parsed = parseOAuthRequestFields(trimmed);
    if (parsed) {
      return sanitizeOAuthTraceValue(parsed);
    }
  }

  return trimmed
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|code_verifier)\b(\s*[:=]\s*)([^\s&,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]");
}

function sanitizeOAuthUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryParamName(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    if (url.hash) {
      url.hash = "#[redacted]";
    }
    return url.toString();
  } catch {
    return rawUrl.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
      "Bearer [redacted]"
    );
  }
}

function sanitizeOAuthTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOAuthTraceValue(item));
  }

  if (typeof value === "string") {
    return sanitizeOAuthTraceString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (isSensitiveTraceFieldName(key)) {
        return [key, redactSensitiveValue(entryValue)];
      }
      return [key, sanitizeOAuthTraceValue(entryValue)];
    })
  );
}

function sanitizeOAuthHeaderValue(value: string): string {
  const sanitized = sanitizeOAuthTraceString(value);
  if (typeof sanitized === "string") {
    return sanitized;
  }
  return redactSensitiveValue(value);
}

function sanitizeOAuthHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (isSensitiveHeaderName(key)) {
        return [key, redactSensitiveValue(value)];
      }
      return [key, sanitizeOAuthHeaderValue(value)];
    })
  );
}

function createHttpHistoryEntry(input: {
  step: HttpHistoryEntry["step"];
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): HttpHistoryEntry {
  return {
    step: input.step,
    timestamp: Date.now(),
    request: {
      method: input.method,
      url: SANITIZE_OAUTH_TRACES ? sanitizeOAuthUrl(input.url) : input.url,
      headers: traceOAuthHeaders(input.headers ?? {}),
      body: traceOAuthValue(input.body),
    },
  };
}

function traceOAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return SANITIZE_OAUTH_TRACES
    ? sanitizeOAuthHeaders(headers)
    : { ...headers };
}

function traceOAuthValue(value: unknown): unknown {
  return SANITIZE_OAUTH_TRACES ? sanitizeOAuthTraceValue(value) : value;
}

function parseOAuthResponseText(
  text: string,
  contentType: string,
): unknown {
  const looksJson =
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    text.startsWith("{") ||
    text.startsWith("[");

  if (!looksJson) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBodyForTrace(response: Response): Promise<unknown> {
  try {
    const text = await response.clone().text();
    if (!text) {
      return null;
    }

    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    return traceOAuthValue(parseOAuthResponseText(text, contentType));
  } catch {
    return null;
  }
}

function cloneEmptyFlowState(): OAuthFlowState {
  return {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
}

function cloneFlowState(state: OAuthFlowState): OAuthFlowState {
  return JSON.parse(JSON.stringify(state)) as OAuthFlowState;
}

function stripOAuthTraceDataFromFlowState(
  state: OAuthFlowState
): OAuthFlowState {
  return {
    ...cloneFlowState(state),
    httpHistory: [],
    infoLogs: [],
    lastRequest: undefined,
    lastResponse: undefined,
    error: undefined,
  };
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function parseOAuthResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return traceOAuthValue(parseOAuthResponseText(text, contentType));
}

function serializeOAuthRequestBody(
  body: HttpHistoryEntry["request"]["body"],
  headers: Record<string, string>
): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string" || body instanceof URLSearchParams) {
    return body;
  }

  const contentType =
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type"
    )?.[1] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(
      Object.entries(body as Record<string, string>).map(([key, value]) => [
        key,
        String(value),
      ])
    ).toString();
  }

  return JSON.stringify(body);
}

function saveOAuthFlowSession(
  serverName: string,
  session: StoredOAuthFlowSession
): void {
  const persistedSession: StoredOAuthFlowSession = {
    ...session,
    state: stripOAuthTraceDataFromFlowState(session.state),
  };
  localStorage.setItem(
    getFlowStateStorageKey(serverName),
    JSON.stringify(persistedSession)
  );
}

function loadOAuthFlowSession(
  serverName: string
): StoredOAuthFlowSession | undefined {
  try {
    const raw = localStorage.getItem(getFlowStateStorageKey(serverName));
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as StoredOAuthFlowSession;
    if (
      parsed?.version !== 1 ||
      !parsed.state ||
      (parsed.protocolVersion !== "2025-03-26" &&
        parsed.protocolVersion !== "2025-06-18" &&
        parsed.protocolVersion !== "2025-11-25")
    ) {
      return undefined;
    }

    return {
      ...parsed,
      state: stripOAuthTraceDataFromFlowState(parsed.state),
    };
  } catch {
    return undefined;
  }
}

function clearOAuthFlowSession(serverName: string): void {
  localStorage.removeItem(getFlowStateStorageKey(serverName));
}

function resolveOAuthProtocolMode(
  options: Pick<MCPOAuthOptions, "protocolMode" | "protocolVersion">,
): OAuthProtocolMode {
  if (options.protocolMode) {
    return options.protocolMode;
  }

  return options.protocolVersion ?? "auto";
}

function resolveOAuthRegistrationMode(
  options: Pick<
    MCPOAuthOptions,
    | "registrationMode"
    | "registrationStrategy"
    | "clientId"
    | "clientSecret"
    | "useRegistryOAuthProxy"
  >,
): OAuthRegistrationMode {
  if (options.registrationMode) {
    return options.registrationMode;
  }

  if (options.registrationStrategy) {
    return options.registrationStrategy;
  }

  if (
    options.useRegistryOAuthProxy ||
    options.clientId ||
    options.clientSecret
  ) {
    return "preregistered";
  }

  return "auto";
}

async function resolveOAuthExecutionPlan(
  provider: MCPOAuthProvider,
  fetchFn: typeof fetch,
  options: Pick<
    MCPOAuthOptions,
    | "serverUrl"
    | "protocolMode"
    | "protocolVersion"
    | "registrationMode"
    | "registrationStrategy"
    | "clientId"
    | "clientSecret"
    | "useRegistryOAuthProxy"
    | "customHeaders"
  >,
): Promise<ResolvedAuthorizationPlan> {
  const basePlan = resolveAuthorizationPlan({
    serverUrl: options.serverUrl,
    protocolMode: resolveOAuthProtocolMode(options),
    protocolVersion: options.protocolVersion,
    registrationMode: resolveOAuthRegistrationMode(options),
    registrationStrategy: options.registrationStrategy,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    useRegistryOAuthProxy: options.useRegistryOAuthProxy,
    authMode: "interactive",
  });

  if (basePlan.status !== "discovery_required") {
    return basePlan;
  }

  const discoveryState = await loadCallbackDiscoveryState(
    provider,
    options.serverUrl,
    fetchFn
  );

  return resolveAuthorizationPlan({
    serverUrl: options.serverUrl,
    protocolMode: resolveOAuthProtocolMode(options),
    protocolVersion: options.protocolVersion,
    registrationMode: resolveOAuthRegistrationMode(options),
    registrationStrategy: options.registrationStrategy,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    useRegistryOAuthProxy: options.useRegistryOAuthProxy,
    authMode: "interactive",
    discovery: toAuthorizationDiscoverySnapshot(discoveryState),
  });
}

function normalizeProxyTargetUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function shouldRetryMcpRequestViaProxy(
  request: HttpHistoryEntry["request"],
  serverUrl: string | undefined
): boolean {
  if (!serverUrl) {
    return false;
  }

  return (
    normalizeProxyTargetUrl(request.url) === normalizeProxyTargetUrl(serverUrl)
  );
}

async function executeRequestViaProxy(
  request: HttpHistoryEntry["request"]
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  ok: boolean;
}> {
  const proxyBase = HOSTED_MODE ? "/api/web/oauth" : "/api/mcp/oauth";
  const response = await authFetch(`${proxyBase}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
    }),
  });

  if (!response.ok) {
    const body = await parseOAuthResponseBody(response);
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `MCP request proxy failed (${response.status})`;
    throw new Error(message);
  }

  const proxied = (await response.json()) as {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    body: unknown;
  };

  return {
    status: proxied.status,
    statusText: proxied.statusText,
    headers: proxied.headers ?? {},
    body: traceOAuthValue(proxied.body),
    ok: proxied.status >= 200 && proxied.status < 300,
  };
}

async function createTraceResponseFromFetch(
  response: Response,
): Promise<HttpHistoryEntry["response"]> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: traceOAuthHeaders(Object.fromEntries(response.headers.entries())),
    body: await readResponseBodyForTrace(response),
  };
}

function createTraceResponseFromResult(
  result: Pick<OAuthRequestResult, "status" | "statusText" | "headers" | "body">,
): HttpHistoryEntry["response"] {
  return {
    status: result.status,
    statusText: result.statusText,
    headers: traceOAuthHeaders(result.headers ?? {}),
    body: traceOAuthValue(result.body),
  };
}

function createOAuthRequestExecutor(fetchFn: typeof fetch, serverUrl?: string) {
  return async (request: HttpHistoryEntry["request"]) => {
    let response:
      | {
          status: number;
          statusText: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }
      | undefined;

    try {
      const directResponse = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: serializeOAuthRequestBody(request.body, request.headers),
      });
      response = {
        status: directResponse.status,
        statusText: directResponse.statusText,
        headers: normalizeResponseHeaders(directResponse.headers),
        body: await parseOAuthResponseBody(directResponse),
        ok: directResponse.ok,
      };
    } catch (error) {
      if (!shouldRetryMcpRequestViaProxy(request, serverUrl)) {
        throw error;
      }

      response = await executeRequestViaProxy(request);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      ok: response.ok,
    };
  };
}

function saveDiscoveryStateFromFlowState(
  provider: MCPOAuthProvider,
  state: OAuthFlowState
): Promise<void> {
  if (!state.authorizationServerUrl) {
    return Promise.resolve();
  }

  return provider.saveDiscoveryState({
    authorizationServerUrl: state.authorizationServerUrl,
    ...(state.resourceMetadata
      ? {
          resourceMetadata: state.resourceMetadata,
        }
      : {}),
    ...(state.authorizationServerMetadata
      ? {
          authorizationServerMetadata: state.authorizationServerMetadata,
        }
      : {}),
  });
}

async function persistOAuthStateArtifacts(
  provider: MCPOAuthProvider,
  state: OAuthFlowState
): Promise<void> {
  if (state.clientId) {
    await provider.saveClientInformation({
      client_id: state.clientId,
      ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
    });
  }

  if (state.codeVerifier) {
    await provider.saveCodeVerifier(state.codeVerifier);
  }

  if (state.accessToken) {
    await provider.saveTokens({
      access_token: state.accessToken,
      ...(state.refreshToken ? { refresh_token: state.refreshToken } : {}),
      ...(state.tokenType ? { token_type: state.tokenType } : {}),
      ...(typeof state.expiresIn === "number"
        ? { expires_in: state.expiresIn }
        : {}),
    });
  }

  await saveDiscoveryStateFromFlowState(provider, state);
}

function buildOAuthTraceFromFlowState(input: {
  source: "interactive_connect" | "callback";
  serverName?: string;
  serverUrl?: string;
  state: OAuthFlowState;
}): OAuthTrace {
  return buildOAuthTraceFromSnapshot({
    source: input.source,
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    snapshot: projectOAuthTraceSnapshot({
      state: input.state,
      sanitize: SANITIZE_OAUTH_TRACES,
    }),
  });
}

function buildStoredOAuthTrace(input: {
  serverName: string;
  serverUrl: string;
  session: StoredOAuthFlowSession;
}): OAuthTrace {
  return buildOAuthTraceFromSnapshot({
    source: "interactive_connect",
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    snapshot: projectOAuthTraceSnapshot({
      state: input.session.state,
      sanitize: true,
    }),
  });
}

export function readStoredOAuthConfig(
  serverName: string | null
): StoredOAuthConfig {
  if (!serverName) {
    return {
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    };
  }

  try {
    const raw = localStorage.getItem(`mcp-oauth-config-${serverName}`);
    if (!raw) {
      return {
        registryServerId: undefined,
        useRegistryOAuthProxy: false,
      };
    }

    const parsed = JSON.parse(raw);
    const config: StoredOAuthConfig = {
      registryServerId:
        typeof parsed?.registryServerId === "string"
          ? parsed.registryServerId
          : undefined,
      useRegistryOAuthProxy: parsed?.useRegistryOAuthProxy === true,
      protocolMode:
        parsed?.protocolMode === "auto" ||
        parsed?.protocolMode === "2025-03-26" ||
        parsed?.protocolMode === "2025-06-18" ||
        parsed?.protocolMode === "2025-11-25"
          ? parsed.protocolMode
          : undefined,
      protocolVersion:
        parsed?.protocolVersion === "2025-03-26" ||
        parsed?.protocolVersion === "2025-06-18" ||
        parsed?.protocolVersion === "2025-11-25"
          ? parsed.protocolVersion
          : undefined,
      registrationMode:
        parsed?.registrationMode === "auto" ||
        parsed?.registrationMode === "cimd" ||
        parsed?.registrationMode === "dcr" ||
        parsed?.registrationMode === "preregistered"
          ? parsed.registrationMode
          : undefined,
      registrationStrategy:
        parsed?.registrationStrategy === "cimd" ||
        parsed?.registrationStrategy === "dcr" ||
        parsed?.registrationStrategy === "preregistered"
          ? parsed.registrationStrategy
          : undefined,
    };

    if (
      Array.isArray(parsed?.scopes) &&
      parsed.scopes.every((scope: unknown) => typeof scope === "string")
    ) {
      config.scopes = parsed.scopes;
    }

    if (
      parsed?.customHeaders &&
      typeof parsed.customHeaders === "object" &&
      !Array.isArray(parsed.customHeaders)
    ) {
      config.customHeaders = Object.fromEntries(
        Object.entries(parsed.customHeaders).filter(
          ([, value]) => typeof value === "string"
        ) as Array<[string, string]>
      );
    }

    return config;
  } catch {
    return {
      registryServerId: undefined,
      useRegistryOAuthProxy: false,
    };
  }
}

export function buildStoredOAuthConfig(
  options: Pick<
    MCPOAuthOptions,
    | "scopes"
    | "registryServerId"
    | "useRegistryOAuthProxy"
    | "customHeaders"
    | "protocolMode"
    | "protocolVersion"
    | "registrationMode"
    | "registrationStrategy"
  >
): StoredOAuthConfig {
  const config: StoredOAuthConfig = {
    registryServerId: options.registryServerId,
    useRegistryOAuthProxy: options.useRegistryOAuthProxy === true,
    protocolMode: options.protocolMode,
    protocolVersion: options.protocolVersion,
    registrationMode: options.registrationMode,
    registrationStrategy: options.registrationStrategy,
  };

  if (options.scopes && options.scopes.length > 0) {
    config.scopes = options.scopes;
  }

  if (options.customHeaders && Object.keys(options.customHeaders).length > 0) {
    config.customHeaders = options.customHeaders;
  }

  return config;
}

function parseOAuthRequestFields(
  body: unknown
): OAuthRequestFields | undefined {
  if (!body) return undefined;

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) {
      return undefined;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const entries = Object.entries(parsed).flatMap(([key, value]) => {
            if (typeof value === "string") {
              return [[key, value] as const];
            }
            if (typeof value === "number" || typeof value === "boolean") {
              return [[key, String(value)] as const];
            }
            return [];
          });
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        }
      } catch {
        // Fall through to URLSearchParams parsing.
      }
    }

    const params = new URLSearchParams(trimmed);
    const entries = Object.fromEntries(params.entries());
    return Object.keys(entries).length > 0 ? entries : undefined;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const entries = Object.entries(body).flatMap(([key, value]) => {
    if (typeof value === "string") {
      return [[key, value] as const];
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return [[key, String(value)] as const];
    }
    return [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getOAuthGrantType(body: unknown): string | undefined {
  return parseOAuthRequestFields(body)?.grant_type;
}

export function isOAuthTokenGrantRequest(
  method: string,
  body: unknown
): body is OAuthRequestFields {
  if (method !== "POST") {
    return false;
  }

  const grantType = getOAuthGrantType(body);
  return grantType === "authorization_code" || grantType === "refresh_token";
}

type OAuthRoutingRequestConfig = OAuthRoutingConfig & {
  method: string;
  body: unknown;
};

export function shouldUseRegistryOAuthProxy(
  config: OAuthRoutingRequestConfig
): config is OAuthRoutingRequestConfig & {
  body: OAuthRequestFields;
} {
  const { registryServerId, useRegistryOAuthProxy, method, body } = config;
  if (!registryServerId || !useRegistryOAuthProxy) {
    return false;
  }

  return isOAuthTokenGrantRequest(method, body);
}

function toConvexOAuthPayload(
  registryServerId: string,
  fields: OAuthRequestFields
): Record<string, string> {
  const payload: Record<string, string> = {
    registryServerId,
    ...fields,
  };

  if (fields.grant_type) {
    payload.grantType = fields.grant_type;
  }
  if (fields.redirect_uri) {
    payload.redirectUri = fields.redirect_uri;
  }
  if (fields.code_verifier) {
    payload.codeVerifier = fields.code_verifier;
  }
  if (fields.refresh_token) {
    payload.refreshToken = fields.refresh_token;
  }
  if (fields.client_id) {
    payload.clientId = fields.client_id;
  }
  if (fields.client_secret) {
    payload.clientSecret = fields.client_secret;
  }

  return payload;
}

async function loadCallbackDiscoveryState(
  provider: MCPOAuthProvider,
  serverUrl: string,
  fetchFn: typeof fetch
): Promise<OAuthDiscoveryState> {
  const cachedState = await provider.discoveryState();
  if (cachedState?.authorizationServerUrl) {
    const authorizationServerMetadata =
      cachedState.authorizationServerMetadata ??
      (await discoverAuthorizationServerMetadata(
        cachedState.authorizationServerUrl,
        { fetchFn }
      ));

    const discoveryState: OAuthDiscoveryState = {
      ...cachedState,
      authorizationServerMetadata,
    };
    await provider.saveDiscoveryState(discoveryState);
    return discoveryState;
  }

  const discovered = await discoverOAuthServerInfo(serverUrl, { fetchFn });
  const discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl: discovered.authorizationServerUrl,
    resourceMetadata: discovered.resourceMetadata,
    authorizationServerMetadata: discovered.authorizationServerMetadata,
  };
  await provider.saveDiscoveryState(discoveryState);
  return discoveryState;
}

function toAuthorizationDiscoverySnapshot(
  discoveryState: OAuthDiscoveryState
): AuthorizationDiscoverySnapshot {
  return {
    authorizationServerMetadataUrl: discoveryState.authorizationServerUrl,
    authorizationServerMetadata: discoveryState.authorizationServerMetadata as
      | Record<string, unknown>
      | undefined,
    resourceMetadataUrl: discoveryState.resourceMetadataUrl,
    resourceMetadata: discoveryState.resourceMetadata as
      | Record<string, unknown>
      | undefined,
  };
}

/**
 * Custom fetch interceptor that proxies OAuth requests through our server to avoid CORS.
 * When a registryServerId is provided, token exchange/refresh is routed through
 * the Convex HTTP registry OAuth endpoints which inject server-side secrets.
 */
function createOAuthFetchInterceptor(
  routingConfig: OAuthRoutingConfig = {},
  trace?: OAuthTrace
): typeof fetch {
  return async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const method = (init?.method || "GET").toUpperCase();
    const serializedBody = init?.body
      ? await serializeBody(init.body)
      : undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
    const oauthGrantType = getOAuthGrantType(serializedBody);
    const registryTokenRequest = {
      ...routingConfig,
      method,
      body: serializedBody,
    };
    const isRegistryTokenRequest =
      shouldUseRegistryOAuthProxy(registryTokenRequest);

    // Check if this is an OAuth-related request that needs CORS bypass
    const isOAuthRequest =
      url.includes("/.well-known/") ||
      url.match(/\/(register|token|authorize)$/) ||
      oauthGrantType === "authorization_code" ||
      oauthGrantType === "refresh_token";

    if (!isOAuthRequest) {
      return await originalFetch(input, init);
    }

    const traceStep =
      oauthGrantType === "authorization_code" ||
      oauthGrantType === "refresh_token"
        ? "token_request"
        : url.includes("/register")
        ? "request_client_registration"
        : url.includes("oauth-protected-resource")
        ? "request_resource_metadata"
        : url.includes("/.well-known/")
        ? "request_authorization_server_metadata"
        : "authorization_request";
    const entry = createHttpHistoryEntry({
      step: traceStep,
      method,
      url,
      headers: init?.headers
        ? Object.fromEntries(new Headers(init.headers as HeadersInit))
        : {},
      body: serializedBody,
    });
    if (trace) {
      appendOAuthTraceHttpHistory(trace, entry);
    }

    // For registry servers, route token exchange/refresh through Convex HTTP actions
    if (isRegistryTokenRequest) {
      const convexSiteUrl = getConvexSiteUrl();
      if (convexSiteUrl) {
        const endpoint =
          registryTokenRequest.body.grant_type === "refresh_token"
            ? "/registry/oauth/refresh"
            : "/registry/oauth/token";
        const response = await authFetch(`${convexSiteUrl}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            toConvexOAuthPayload(
              routingConfig.registryServerId!,
              registryTokenRequest.body
            )
          ),
        });
        entry.response = await createTraceResponseFromFetch(response);
        entry.duration = Date.now() - entry.timestamp;
        return response;
      }
    }

    // Proxy OAuth requests through our server
    try {
      const isMetadata = url.includes("/.well-known/");
      const proxyBase = HOSTED_MODE ? "/api/web/oauth" : "/api/mcp/oauth";
      const proxyUrl = isMetadata
        ? `${proxyBase}/metadata?url=${encodeURIComponent(url)}`
        : `${proxyBase}/proxy`;

      if (isMetadata) {
        const response = await authFetch(proxyUrl, { ...init, method: "GET" });
        entry.response = await createTraceResponseFromFetch(response);
        entry.duration = Date.now() - entry.timestamp;
        return response;
      }

      // For OAuth endpoints, serialize and proxy the full request
      const response = await authFetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          method,
          headers: init?.headers
            ? Object.fromEntries(new Headers(init.headers as HeadersInit))
            : {},
          body: serializedBody,
        }),
      });

      // If the proxy call itself failed (e.g., auth error), return that response directly
      if (!response.ok) {
        entry.response = await createTraceResponseFromFetch(response);
        entry.duration = Date.now() - entry.timestamp;
        return response;
      }

      const data = await response.json();
      entry.response = createTraceResponseFromResult({
        status: data.status,
        statusText: data.statusText,
        headers: data.headers ?? {},
        body: data.body,
      });
      entry.duration = Date.now() - entry.timestamp;
      return new Response(JSON.stringify(data.body), {
        status: data.status,
        statusText: data.statusText,
        headers: new Headers(data.headers),
      });
    } catch (error) {
      entry.error = {
        message: error instanceof Error ? error.message : String(error),
      };
      entry.duration = Date.now() - entry.timestamp;
      console.error("OAuth proxy failed:", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}

/**
 * Serialize request body for proxying
 */
async function serializeBody(body: BodyInit): Promise<any> {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Fall back to form-style parsing below.
      }
    }
    return parseOAuthRequestFields(trimmed) ?? body;
  }
  if (body instanceof URLSearchParams || body instanceof FormData) {
    return Object.fromEntries(body.entries());
  }
  if (body instanceof Blob) return await body.text();
  return body;
}

export interface MCPOAuthOptions {
  serverName: string;
  serverUrl: string;
  scopes?: string[];
  customHeaders?: Record<string, string>;
  clientId?: string;
  clientSecret?: string;
  /** Registry record identifier for bookkeeping and optional Convex token exchange */
  registryServerId?: string;
  /** True only for registry servers with backend-managed preregistered OAuth credentials */
  useRegistryOAuthProxy?: boolean;
  protocolMode?: OAuthProtocolMode;
  protocolVersion?: OAuthProtocolVersion;
  registrationMode?: OAuthRegistrationMode;
  registrationStrategy?: OAuthRegistrationStrategy;
  onTraceUpdate?: (trace: OAuthTrace) => void;
}

export interface OAuthResult {
  success: boolean;
  serverConfig?: HttpServerConfig;
  error?: string;
  oauthTrace?: OAuthTrace;
}

interface HostedOAuthCompletionResponse {
  success: boolean;
  expiresAt?: number | null;
  kind?: "generic" | "registry";
  error?: string;
  oauthTrace?: OAuthTrace;
}

interface HostedOAuthSessionProgressResponse {
  success: boolean;
  sessionId?: string;
  status?: "pending" | "running" | "succeeded" | "failed";
  updatedAt?: number;
  completedAt?: number;
  lastError?: string;
  error?: string;
  oauthTrace?: OAuthTrace;
}

const HOSTED_OAUTH_PROGRESS_POLL_MS = 250;

function publishOAuthTraceUpdate(
  _serverName: string | undefined,
  trace: OAuthTrace,
  onTraceUpdate?: (trace: OAuthTrace) => void
): OAuthTrace {
  onTraceUpdate?.(trace);
  return trace;
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readHostedOAuthExpectedState(state: OAuthFlowState): string {
  const expectedState =
    typeof state.state === "string" ? state.state.trim() : "";
  if (!expectedState) {
    throw new Error("OAuth state not ready for hosted callback session.");
  }

  return expectedState;
}

async function createHostedOAuthSessionIfNeeded(input: {
  serverName: string;
  serverUrl: string;
  redirectUrl: string;
  state: OAuthFlowState;
}): Promise<string | undefined> {
  if (!HOSTED_MODE) {
    return undefined;
  }

  const pendingMarker = readHostedOAuthPendingMarker();
  if (
    !pendingMarker?.workspaceId ||
    !pendingMarker.serverId ||
    !matchesHostedOAuthServerIdentity(
      {
        serverName: pendingMarker.serverName,
        serverUrl: pendingMarker.serverUrl,
      },
      {
        serverName: input.serverName,
        serverUrl: input.serverUrl,
      }
    )
  ) {
    return undefined;
  }

  const clientId = input.state.clientId;
  if (!clientId) {
    throw new Error("OAuth client ID not ready for hosted callback session.");
  }

  const codeVerifier = input.state.codeVerifier;
  if (!codeVerifier) {
    throw new Error("Code verifier not ready for hosted callback session.");
  }
  const expectedState = readHostedOAuthExpectedState(input.state);

  const response = await authFetch("/api/web/oauth/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: pendingMarker.workspaceId,
      serverId: pendingMarker.serverId,
      codeVerifier,
      redirectUri: input.redirectUrl,
      expectedState,
      clientInformation: {
        clientId,
        ...(input.state.clientSecret
          ? { clientSecret: input.state.clientSecret }
          : {}),
      },
      ...(pendingMarker.accessScope
        ? { accessScope: pendingMarker.accessScope }
        : {}),
      ...(pendingMarker.shareToken
        ? { shareToken: pendingMarker.shareToken }
        : {}),
      ...(pendingMarker.chatboxToken
        ? { chatboxToken: pendingMarker.chatboxToken }
        : {}),
    }),
  });
  const result = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    success?: boolean;
    sessionId?: string;
    error?: string;
  } | null;

  if (
    !response.ok ||
    !result?.success ||
    typeof result.sessionId !== "string"
  ) {
    throw new Error(
      result?.error || `Hosted OAuth session failed (${response.status})`
    );
  }

  writeHostedOAuthPendingMarker({
    ...pendingMarker,
    sessionId: result.sessionId,
  });
  return result.sessionId;
}

async function readHostedOAuthSessionProgress(input: {
  convexSiteUrl: string;
  context: HostedOAuthCallbackContext;
}): Promise<HostedOAuthSessionProgressResponse | null> {
  if (
    !input.context.workspaceId ||
    !input.context.serverId ||
    !input.context.sessionId
  ) {
    return null;
  }

  const response = await authFetch(
    `${input.convexSiteUrl}/web/oauth/session/progress`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: input.context.workspaceId,
        serverId: input.context.serverId,
        sessionId: input.context.sessionId,
        ...(input.context.accessScope
          ? { accessScope: input.context.accessScope }
          : {}),
        ...(input.context.shareToken
          ? { shareToken: input.context.shareToken }
          : {}),
        ...(input.context.chatboxToken
          ? { chatboxToken: input.context.chatboxToken }
          : {}),
      }),
    }
  );

  if (!response.ok) {
    return null;
  }

  return (await response
    .json()
    .catch(() => null)) as HostedOAuthSessionProgressResponse | null;
}

/**
 * Simple localStorage-based OAuth provider for MCP
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private serverUrl: string;
  private redirectUri: string;
  private customClientId?: string;
  private customClientSecret?: string;

  constructor(
    serverName: string,
    serverUrl: string,
    customClientId?: string,
    customClientSecret?: string
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.redirectUri = getRedirectUri();
    this.customClientId = customClientId;
    this.customClientSecret = customClientSecret;
  }

  state(): string {
    return generateRandomString(32);
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata() {
    return {
      client_name: `MCPJam - ${this.serverName}`,
      client_uri: "https://github.com/mcpjam/inspector",
      logo_uri: "https://www.mcpjam.com/mcp_jam_2row.png",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    const stored = localStorage.getItem(`mcp-client-${this.serverName}`);
    const storedJson = stored ? JSON.parse(stored) : undefined;

    // If custom client ID is provided, use it
    if (this.customClientId) {
      if (storedJson) {
        // If there's stored information, merge with custom client credentials
        const result = {
          ...storedJson,
          client_id: this.customClientId,
        };
        // Add client secret if provided
        if (this.customClientSecret) {
          result.client_secret = this.customClientSecret;
        }
        return result;
      } else {
        // If no stored information, create a minimal client info with custom credentials
        const result: any = {
          client_id: this.customClientId,
        };
        if (this.customClientSecret) {
          result.client_secret = this.customClientSecret;
        }
        return result;
      }
    }
    return storedJson;
  }

  async saveClientInformation(clientInformation: any) {
    localStorage.setItem(
      `mcp-client-${this.serverName}`,
      JSON.stringify(clientInformation)
    );
  }

  tokens() {
    const stored = localStorage.getItem(`mcp-tokens-${this.serverName}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveTokens(tokens: any) {
    localStorage.setItem(
      `mcp-tokens-${this.serverName}`,
      JSON.stringify(tokens)
    );
  }

  prepareTokenRequest() {
    const currentTokens = this.tokens();
    if (!currentTokens?.refresh_token) {
      return undefined;
    }

    return new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentTokens.refresh_token,
    });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const stored = localStorage.getItem(
      getDiscoveryStorageKey(this.serverName)
    );
    if (!stored) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(stored) as Partial<StoredOAuthDiscoveryState>;
      if (
        parsed?.serverUrl !== this.serverUrl ||
        typeof parsed.discoveryState !== "object" ||
        parsed.discoveryState === null
      ) {
        return undefined;
      }

      return parsed.discoveryState;
    } catch {
      return undefined;
    }
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
    const payload: StoredOAuthDiscoveryState = {
      serverUrl: this.serverUrl,
      discoveryState,
    };
    localStorage.setItem(
      getDiscoveryStorageKey(this.serverName),
      JSON.stringify(payload)
    );
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    captureServerDetailModalOAuthResume(this.serverName);
    // Store server name for callback recovery
    localStorage.setItem("mcp-oauth-pending", this.serverName);
    // Store current hash to restore after OAuth callback
    if (window.location.hash) {
      localStorage.setItem("mcp-oauth-return-hash", window.location.hash);
    }
    window.location.href = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string) {
    localStorage.setItem(`mcp-verifier-${this.serverName}`, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = localStorage.getItem(`mcp-verifier-${this.serverName}`);
    if (!verifier) {
      throw new Error("Code verifier not found");
    }
    return verifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ) {
    switch (scope) {
      case "all":
        localStorage.removeItem(`mcp-tokens-${this.serverName}`);
        localStorage.removeItem(`mcp-client-${this.serverName}`);
        localStorage.removeItem(`mcp-verifier-${this.serverName}`);
        clearStoredDiscoveryState(this.serverName);
        break;
      case "client":
        localStorage.removeItem(`mcp-client-${this.serverName}`);
        break;
      case "tokens":
        localStorage.removeItem(`mcp-tokens-${this.serverName}`);
        break;
      case "verifier":
        localStorage.removeItem(`mcp-verifier-${this.serverName}`);
        break;
      case "discovery":
        clearStoredDiscoveryState(this.serverName);
        break;
    }
  }
}

function readStoredClientInformation(
  serverName: string
): StoredOAuthClientInformation {
  try {
    const stored = localStorage.getItem(`mcp-client-${serverName}`);
    if (!stored) {
      return {};
    }

    const parsed = JSON.parse(stored) as StoredOAuthClientInformation;
    return {
      client_id:
        typeof parsed.client_id === "string" ? parsed.client_id : undefined,
      client_secret:
        typeof parsed.client_secret === "string"
          ? parsed.client_secret
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Initiates OAuth flow for an MCP server
 */
export async function initiateOAuth(
  options: MCPOAuthOptions
): Promise<OAuthResult> {
  let state = cloneEmptyFlowState();
  const updateState = (updates: Partial<OAuthFlowState>) => {
    state = { ...state, ...updates };
  };
  const getState = () => state;
  const emitTraceSnapshot = (snapshot: OAuthTraceSnapshot) =>
    publishOAuthTraceUpdate(
      options.serverName,
      buildOAuthTraceFromSnapshot({
        source: "interactive_connect",
        serverName: options.serverName,
        serverUrl: options.serverUrl,
        snapshot,
      }),
      options.onTraceUpdate
    );
  const emitTraceFromState = (nextState: OAuthFlowState) =>
    publishOAuthTraceUpdate(
      options.serverName,
      buildOAuthTraceFromFlowState({
        source: "interactive_connect",
        serverName: options.serverName,
        serverUrl: options.serverUrl,
        state: nextState,
      }),
      options.onTraceUpdate
    );

  try {
    const provider = new MCPOAuthProvider(
      options.serverName,
      options.serverUrl,
      options.clientId,
      options.clientSecret
    );
    const fetchFn = createOAuthFetchInterceptor(
      {
        registryServerId: options.registryServerId,
        useRegistryOAuthProxy: options.useRegistryOAuthProxy,
      },
      undefined
    );
    const authorizationPlan = await resolveOAuthExecutionPlan(
      provider,
      fetchFn,
      options
    );
    if (
      authorizationPlan.status !== "ready" ||
      !authorizationPlan.registrationStrategy
    ) {
      return {
        success: false,
        error:
          authorizationPlan.blockers[0] || authorizationPlan.summary,
      };
    }
    const protocolVersion = authorizationPlan.protocolVersion;
    const registrationStrategy = authorizationPlan.registrationStrategy;
    const requestExecutor = createOAuthRequestExecutor(
      fetchFn,
      options.serverUrl
    );

    // Store server URL for callback recovery
    localStorage.setItem(
      `mcp-serverUrl-${options.serverName}`,
      options.serverUrl
    );
    localStorage.setItem("mcp-oauth-pending", options.serverName);

    // Store OAuth configuration (scopes, registryServerId) for recovery if connection fails
    const oauthConfig = buildStoredOAuthConfig({
      ...options,
      protocolMode: resolveOAuthProtocolMode(options),
      protocolVersion,
      registrationMode: resolveOAuthRegistrationMode(options),
      registrationStrategy,
    });
    localStorage.setItem(
      `mcp-oauth-config-${options.serverName}`,
      JSON.stringify(oauthConfig)
    );

    // Store custom client credentials if provided, so they can be retrieved during callback
    if (options.clientId || options.clientSecret) {
      const existingClientInfo = localStorage.getItem(
        `mcp-client-${options.serverName}`
      );
      const existingJson = existingClientInfo
        ? JSON.parse(existingClientInfo)
        : {};

      const updatedClientInfo: any = { ...existingJson };
      if (options.clientId) {
        updatedClientInfo.client_id = options.clientId;
      }
      if (options.clientSecret) {
        updatedClientInfo.client_secret = options.clientSecret;
      }

      localStorage.setItem(
        `mcp-client-${options.serverName}`,
        JSON.stringify(updatedClientInfo)
      );
    }

    const requestedScope =
      options.scopes && options.scopes.length > 0
        ? options.scopes.join(" ")
        : undefined;
    const flowResult = await runOAuthStateMachine({
      protocolVersion,
      registrationStrategy,
      state,
      getState,
      updateState,
      serverUrl: options.serverUrl,
      serverName: options.serverName,
      redirectUrl: provider.redirectUrl,
      sanitizeTrace: SANITIZE_OAUTH_TRACES,
      requestExecutor,
      loadPreregisteredCredentials: async () => {
        const clientInformation = provider.clientInformation();
        return {
          clientId: clientInformation?.client_id,
          clientSecret: clientInformation?.client_secret,
        };
      },
      dynamicRegistration: {
        ...getBrowserDebugDynamicRegistrationMetadata(protocolVersion),
        ...provider.clientMetadata,
      },
      clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
      customScopes: requestedScope,
      customHeaders: options.customHeaders,
      authMode: "interactive",
      onTraceUpdate: ({ trace: snapshot }) => {
        emitTraceSnapshot(snapshot);
      },
      onAuthorizationRequest: async ({ authorizationUrl }) => {
        await createHostedOAuthSessionIfNeeded({
          serverName: options.serverName,
          serverUrl: options.serverUrl,
          redirectUrl: provider.redirectUrl,
          state: getState(),
        });
        await persistOAuthStateArtifacts(provider, getState());
        saveOAuthFlowSession(options.serverName, {
          version: 1,
          protocolVersion,
          registrationStrategy,
          state: cloneFlowState(getState()),
        });
        emitTraceFromState(getState());
        await provider.redirectToAuthorization(new URL(authorizationUrl));
        return { type: "redirect" };
      },
    });

    const trace = emitTraceFromState(flowResult.state);

    if (flowResult.error) {
      return {
        success: false,
        error: formatOAuthCallbackError(flowResult.error.message),
        oauthTrace: trace,
      };
    }

    if (flowResult.redirected) {
      return {
        success: true,
        oauthTrace: trace,
      };
    }

    if (flowResult.completed && flowResult.state.accessToken) {
      await persistOAuthStateArtifacts(provider, flowResult.state);
      clearOAuthFlowSession(options.serverName);
      return {
        success: true,
        serverConfig: createServerConfig(options.serverUrl, {
          access_token: flowResult.state.accessToken,
        }),
        oauthTrace: trace,
      };
    }

    return {
      success: false,
      error: "OAuth flow did not complete.",
      oauthTrace: trace,
    };
  } catch (error) {
    let errorMessage = "Unknown OAuth error";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Provide more helpful error messages for common client ID issues
      if (
        errorMessage.includes("invalid_client") ||
        errorMessage.includes("client_id")
      ) {
        errorMessage =
          "Invalid client ID. Please verify the client ID is correctly registered with the OAuth provider.";
      } else if (errorMessage.includes("unauthorized_client")) {
        errorMessage =
          "Client not authorized. The client ID may not be registered for this server or scope.";
      } else if (errorMessage.includes("invalid_request")) {
        errorMessage =
          "OAuth request invalid. Please check your client ID and try again.";
      }
    }

    const trace = buildOAuthTraceFromFlowState({
      source: "interactive_connect",
      serverName: options.serverName,
      serverUrl: options.serverUrl,
      state: {
        ...getState(),
        error: errorMessage,
      },
    });
    publishOAuthTraceUpdate(options.serverName, trace, options.onTraceUpdate);

    return {
      success: false,
      error: errorMessage,
      oauthTrace: trace,
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

function formatOAuthCallbackError(error: unknown): string {
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "Unknown callback error";

  if (
    errorMessage.includes("invalid_client") ||
    errorMessage.includes("client_id")
  ) {
    return "Invalid client ID during token exchange. Please verify the client ID is correctly registered.";
  }
  if (errorMessage.includes("unauthorized_client")) {
    return "Client not authorized for token exchange. The client ID may not match the one used for authorization.";
  }
  if (errorMessage.includes("invalid_grant")) {
    return "Authorization code invalid or expired. Please try the OAuth flow again.";
  }

  return errorMessage;
}

export async function completeHostedOAuthCallback(
  context: HostedOAuthCallbackContext,
  authorizationCode: string,
  options: {
    callbackState?: string | null;
    onTraceUpdate?: (trace: OAuthTrace) => void;
  } = {}
): Promise<OAuthResult & { serverName?: string; expiresAt?: number | null }> {
  const serverName =
    context.serverName ||
    localStorage.getItem("mcp-oauth-pending") ||
    undefined;
  const callbackTrace = createOAuthTrace({
    source: "hosted_callback",
    serverName: serverName ?? undefined,
  });
  let previousTrace: OAuthTrace | undefined = serverName
    ? loadOAuthTrace(serverName)
    : undefined;
  const mergeHostedCallbackTrace = (backendTrace?: OAuthTrace): OAuthTrace =>
    backendTrace
      ? mergeOAuthTraces(callbackTrace, backendTrace)
      : callbackTrace;
  const emitTrace = (trace: OAuthTrace) =>
    publishOAuthTraceUpdate(
      serverName,
      previousTrace ? mergeOAuthTraces(previousTrace, trace) : trace,
      options.onTraceUpdate
    );
  let stopProgressPolling = false;
  let progressPollingPromise: Promise<void> | null = null;
  let resolveTerminalProgressFailure:
    | ((failure: { message: string; oauthTrace?: OAuthTrace }) => void)
    | null = null;

  try {
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }
    if (!context.workspaceId || !context.serverId) {
      throw new Error("Hosted OAuth callback is missing server context");
    }

    startOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: context.sessionId
        ? "Received hosted OAuth callback and restoring server-side callback state."
        : "Received hosted OAuth callback and loading stored callback state.",
    });
    emitTrace(callbackTrace);
    const serverUrl =
      context.serverUrl || localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }
    const storedSession = loadOAuthFlowSession(serverName);
    previousTrace = storedSession
      ? buildStoredOAuthTrace({
          serverName,
          serverUrl,
          session: storedSession,
        })
      : previousTrace;
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: context.sessionId
        ? "Hosted callback state restored from the shared backend session."
        : "Hosted callback state restored.",
      details: {
        serverUrl,
        ...(context.sessionId
          ? { sessionId: context.sessionId }
          : (() => {
              const clientInformation = readStoredClientInformation(serverName);
              return clientInformation.client_id
                ? { clientId: clientInformation.client_id }
                : {};
            })()),
      },
    });
    emitTrace(callbackTrace);

    const convexSiteUrl = getConvexSiteUrl();
    const terminalProgressFailurePromise =
      context.sessionId && convexSiteUrl
        ? new Promise<{ message: string; oauthTrace?: OAuthTrace }>(
            (resolve) => {
              resolveTerminalProgressFailure = resolve;
            }
          )
        : null;
    const legacyClientInformation = context.sessionId
      ? undefined
      : readStoredClientInformation(serverName);
    const legacyCodeVerifier = context.sessionId
      ? undefined
      : localStorage.getItem(`mcp-verifier-${serverName}`);
    const callbackState =
      typeof options.callbackState === "string"
        ? options.callbackState.trim()
        : "";
    if (!context.sessionId && !legacyCodeVerifier) {
      throw new Error("Code verifier not found");
    }
    if (!context.sessionId && !legacyClientInformation?.client_id) {
      throw new Error("OAuth client ID not found");
    }

    if (context.sessionId && convexSiteUrl) {
      let lastProgressUpdateAt = -1;
      progressPollingPromise = (async () => {
        while (!stopProgressPolling) {
          try {
            const progress = await readHostedOAuthSessionProgress({
              convexSiteUrl,
              context,
            });
            if (
              progress?.success &&
              progress.oauthTrace &&
              typeof progress.updatedAt === "number" &&
              progress.updatedAt !== lastProgressUpdateAt
            ) {
              lastProgressUpdateAt = progress.updatedAt;
              emitTrace(mergeHostedCallbackTrace(progress.oauthTrace));
            }
            if (progress?.success && progress.status === "failed") {
              stopProgressPolling = true;
              if (resolveTerminalProgressFailure) {
                resolveTerminalProgressFailure({
                  message:
                    progress.lastError ||
                    progress.error ||
                    "Hosted OAuth callback failed",
                  oauthTrace: progress.oauthTrace,
                });
              }
              break;
            }
            if (progress?.success && progress.status === "succeeded") {
              stopProgressPolling = true;
              break;
            }
          } catch {
            // Best effort only; final callback response remains authoritative.
          }

          if (stopProgressPolling) {
            break;
          }
          await waitForMs(HOSTED_OAUTH_PROGRESS_POLL_MS);
        }
      })();
    }

    const completionPromise = (async () => {
      const response = await authFetch(`${convexSiteUrl}/web/oauth/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: context.workspaceId,
          serverId: context.serverId,
          code: authorizationCode,
          ...(context.sessionId
            ? {
                sessionId: context.sessionId,
                ...(callbackState ? { state: callbackState } : {}),
              }
            : {
                serverUrl,
                codeVerifier: legacyCodeVerifier,
                redirectUri: getRedirectUri(),
                clientInformation: {
                  clientId: legacyClientInformation!.client_id!,
                  ...(legacyClientInformation?.client_secret
                    ? { clientSecret: legacyClientInformation.client_secret }
                    : {}),
                },
              }),
          ...(context.accessScope ? { accessScope: context.accessScope } : {}),
          ...(context.shareToken ? { shareToken: context.shareToken } : {}),
          ...(context.chatboxToken
            ? { chatboxToken: context.chatboxToken }
            : {}),
        }),
      });

      const result = (await response
        .clone()
        .json()
        .catch(() => null)) as HostedOAuthCompletionResponse | null;
      if (!response.ok) {
        const responseText = await response.text();
        throw {
          message:
            result?.error ||
            responseText ||
            `Hosted OAuth callback failed (${response.status})`,
          oauthTrace: result?.oauthTrace,
        };
      }

      if (!result?.success) {
        throw {
          message: result?.error || "Hosted OAuth callback failed",
          oauthTrace: result?.oauthTrace,
        };
      }

      return result;
    })();
    const result = terminalProgressFailurePromise
      ? await Promise.race([
          completionPromise,
          terminalProgressFailurePromise.then<HostedOAuthCompletionResponse>(
            (failure) => {
              throw failure;
            }
          ),
        ])
      : await completionPromise;

    localStorage.removeItem(`mcp-tokens-${serverName}`);
    localStorage.removeItem(`mcp-verifier-${serverName}`);
    completeOAuthTraceStep(callbackTrace, "token_request", {
      message: "Hosted token exchange succeeded.",
    });
    completeOAuthTraceStep(callbackTrace, "received_access_token", {
      message: "Hosted access token is stored in the backend vault.",
    });
    completeOAuthTraceStep(callbackTrace, "complete", {
      message: "Hosted OAuth callback completed successfully.",
    });
    const mergedTrace = previousTrace
      ? mergeOAuthTraces(
          previousTrace,
          mergeHostedCallbackTrace(result.oauthTrace)
        )
      : mergeHostedCallbackTrace(result.oauthTrace);
    publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);
    clearOAuthFlowSession(serverName);

    return {
      success: true,
      serverName,
      serverConfig: createServerConfig(serverUrl),
      expiresAt: result.expiresAt ?? null,
      oauthTrace: mergedTrace,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
    failOAuthTraceStep(callbackTrace, callbackTrace.currentStep, message, {
      message: "Hosted OAuth callback failed.",
    });
    const backendTrace =
      typeof error === "object" && error !== null && "oauthTrace" in error
        ? (error as { oauthTrace?: OAuthTrace }).oauthTrace ?? undefined
        : undefined;
    const mergedTrace =
      serverName != null
        ? previousTrace
          ? mergeOAuthTraces(
              previousTrace,
              mergeHostedCallbackTrace(backendTrace)
            )
          : mergeHostedCallbackTrace(backendTrace)
        : mergeHostedCallbackTrace(backendTrace);
    if (serverName) {
      publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);
      clearOAuthFlowSession(serverName);
    }
    return {
      success: false,
      error: formatOAuthCallbackError(message),
      oauthTrace: mergedTrace,
    };
  } finally {
    stopProgressPolling = true;
    await progressPollingPromise?.catch(() => undefined);
  }
}

/**
 * Handles OAuth callback and completes the flow
 */
export async function handleOAuthCallback(
  authorizationCode: string,
  options: { onTraceUpdate?: (trace: OAuthTrace) => void } = {}
): Promise<OAuthResult & { serverName?: string }> {
  // Get pending server name from localStorage (needed before creating interceptor)
  const serverName = localStorage.getItem("mcp-oauth-pending");

  // Read registryServerId from stored OAuth config if present
  const oauthConfig = readStoredOAuthConfig(serverName);
  let serverUrl: string | undefined;
  let previousTrace: OAuthTrace | undefined;

  try {
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }

    // Get server URL
    serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`) ?? undefined;
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }

    // Get stored client credentials if any
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;
    const customClientSecret = storedClientInfo
      ? JSON.parse(storedClientInfo).client_secret
      : undefined;

    const provider = new MCPOAuthProvider(
      serverName,
      serverUrl,
      customClientId,
      customClientSecret
    );
    const fetchFn = createOAuthFetchInterceptor(oauthConfig, undefined);
    const requestExecutor = createOAuthRequestExecutor(fetchFn, serverUrl);
    const storedSession = loadOAuthFlowSession(serverName);
    previousTrace = storedSession
      ? buildStoredOAuthTrace({
          serverName,
          serverUrl,
          session: storedSession,
        })
      : undefined;

    if (storedSession) {
      let state = cloneFlowState(storedSession.state);
      const updateState = (updates: Partial<OAuthFlowState>) => {
        state = { ...state, ...updates };
      };
      const getState = () => state;
      const emitTraceSnapshot = (snapshot: OAuthTraceSnapshot) =>
        publishOAuthTraceUpdate(
          serverName,
          mergeOAuthTraces(
            previousTrace,
            buildOAuthTraceFromSnapshot({
              source: "callback",
              serverName,
              serverUrl,
              snapshot,
            })
          ),
          options.onTraceUpdate
        );

      updateState({
        currentStep: "received_authorization_code",
        authorizationCode,
        error: undefined,
      });
      emitTraceSnapshot(
        projectOAuthTraceSnapshot({
          state: getState(),
          sanitize: SANITIZE_OAUTH_TRACES,
        })
      );

      const flowResult = await runOAuthStateMachine({
        protocolVersion: storedSession.protocolVersion,
        registrationStrategy: storedSession.registrationStrategy,
        state,
        getState,
        updateState,
        serverUrl,
        serverName,
        redirectUrl: provider.redirectUrl,
        sanitizeTrace: SANITIZE_OAUTH_TRACES,
        requestExecutor,
        loadPreregisteredCredentials: async () => {
          const clientInformation = provider.clientInformation();
          return {
            clientId: clientInformation?.client_id,
            clientSecret: clientInformation?.client_secret,
          };
        },
        dynamicRegistration: {
          ...getBrowserDebugDynamicRegistrationMetadata(
            storedSession.protocolVersion
          ),
          ...provider.clientMetadata,
        },
        clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
        customScopes: oauthConfig.scopes?.join(" "),
        customHeaders: oauthConfig.customHeaders,
        authMode: "interactive",
        onTraceUpdate: ({ trace: snapshot }) => {
          emitTraceSnapshot(snapshot);
        },
      });

      const callbackTrace = buildOAuthTraceFromFlowState({
        source: "callback",
        serverName,
        serverUrl,
        state: flowResult.state,
      });
      const mergedTrace = mergeOAuthTraces(previousTrace, callbackTrace);
      publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);

      if (
        flowResult.error ||
        !flowResult.completed ||
        !flowResult.state.accessToken
      ) {
        return {
          success: false,
          error: formatOAuthCallbackError(
            flowResult.error?.message || flowResult.state.error
          ),
          oauthTrace: mergedTrace,
        };
      }

      await persistOAuthStateArtifacts(provider, flowResult.state);
      clearOAuthFlowSession(serverName);
      localStorage.removeItem(`mcp-verifier-${serverName}`);
      localStorage.removeItem("mcp-oauth-pending");
      return {
        success: true,
        serverConfig: createServerConfig(serverUrl, {
          access_token: flowResult.state.accessToken,
        }),
        serverName,
        oauthTrace: mergedTrace,
      };
    }

    const callbackTrace = createOAuthTrace({
      source: "callback",
      serverName: serverName ?? undefined,
    });
    const emitTrace = (trace: OAuthTrace) =>
      publishOAuthTraceUpdate(
        serverName,
        mergeOAuthTraces(previousTrace, trace),
        options.onTraceUpdate
      );
    startOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Received OAuth callback and loading stored state.",
      details: {
        serverUrl,
      },
    });
    emitTrace(callbackTrace);
    const clientInformation = await provider.clientInformation();
    if (!clientInformation?.client_id) {
      throw new Error("OAuth client ID not found");
    }
    const discoveryState = await loadCallbackDiscoveryState(
      provider,
      serverUrl,
      fetchFn
    );
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Callback state restored.",
      details: {
        clientId: clientInformation.client_id,
      },
    });
    emitTrace(callbackTrace);
    const resource = await selectResourceURL(
      serverUrl,
      provider,
      discoveryState.resourceMetadata
    );
    startOAuthTraceStep(callbackTrace, "token_request", {
      message: "Exchanging authorization code for OAuth tokens.",
    });
    emitTrace(callbackTrace);
    const tokens = await exchangeAuthorization(
      discoveryState.authorizationServerUrl,
      {
        metadata: discoveryState.authorizationServerMetadata,
        authorizationCode,
        clientInformation,
        codeVerifier: provider.codeVerifier(),
        redirectUri: provider.redirectUrl,
        ...(resource ? { resource } : {}),
        fetchFn,
      }
    );
    await provider.saveTokens(tokens);
    completeOAuthTraceStep(callbackTrace, "token_request", {
      message: "Authorization code exchange succeeded.",
    });
    completeOAuthTraceStep(callbackTrace, "received_access_token", {
      message: "OAuth tokens were stored locally.",
    });
    completeOAuthTraceStep(callbackTrace, "complete", {
      message: "OAuth callback completed successfully.",
    });

    // Clean up pending state
    localStorage.removeItem("mcp-oauth-pending");
    localStorage.removeItem(`mcp-verifier-${serverName}`);
    const mergedTrace = mergeOAuthTraces(previousTrace, callbackTrace);
    publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);

    const serverConfig = createServerConfig(serverUrl, tokens);
    return {
      success: true,
      serverConfig,
      serverName, // Return server name so caller doesn't need to look it up
      oauthTrace: mergedTrace,
    };
  } catch (error) {
    const callbackTrace = buildOAuthTraceFromFlowState({
      source: "callback",
      serverName: serverName ?? undefined,
      serverUrl:
        serverUrl ??
        (serverName != null
          ? localStorage.getItem(`mcp-serverUrl-${serverName}`) ?? ""
          : ""),
      state: {
        ...cloneEmptyFlowState(),
        currentStep: "received_authorization_code",
        error: formatOAuthCallbackError(error),
      },
    });
    const mergedTrace = serverName
      ? mergeOAuthTraces(previousTrace, callbackTrace)
      : callbackTrace;
    if (serverName) {
      publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);
    }
    return {
      success: false,
      error: formatOAuthCallbackError(error),
      oauthTrace: mergedTrace,
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Gets stored tokens for a server, including client_id from client information
 */
export interface StoredTokensState {
  tokens: any;
  isInvalid: boolean;
}

export function getStoredTokensState(serverName: string): StoredTokensState {
  const tokens = localStorage.getItem(`mcp-tokens-${serverName}`);
  const clientInfo = localStorage.getItem(`mcp-client-${serverName}`);
  // TODO: Maybe we should move clientID away from the token info? Not sure if clientID is bonded to token
  if (!tokens) return { tokens: undefined, isInvalid: false };

  try {
    const tokensJson = JSON.parse(tokens);
    const clientJson = clientInfo ? JSON.parse(clientInfo) : {};

    // Merge tokens with client_id from client information
    return {
      tokens: {
        ...tokensJson,
        client_id: clientJson.client_id || tokensJson.client_id,
      },
      isInvalid: false,
    };
  } catch {
    return {
      tokens: undefined,
      isInvalid: true,
    };
  }
}

export function getStoredTokens(serverName: string): any {
  return getStoredTokensState(serverName).tokens;
}

/**
 * Checks if OAuth is configured for a server by looking at multiple sources
 */
export function hasOAuthConfig(serverName: string): boolean {
  const storedServerUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
  const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
  const storedOAuthConfig = localStorage.getItem(
    `mcp-oauth-config-${serverName}`
  );
  const storedTokens = getStoredTokens(serverName);

  return (
    storedServerUrl != null ||
    storedClientInfo != null ||
    storedOAuthConfig != null ||
    storedTokens != null
  );
}

/**
 * Waits for tokens to be available with timeout
 */
export async function waitForTokens(
  serverName: string,
  timeoutMs: number = 5000
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const tokens = getStoredTokens(serverName);
    if (tokens?.access_token) {
      return tokens;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timeout waiting for tokens for server: ${serverName}`);
}

/**
 * Refreshes OAuth tokens for a server using the refresh token
 */
export async function refreshOAuthTokens(
  serverName: string,
  options: { onTraceUpdate?: (trace: OAuthTrace) => void } = {}
): Promise<OAuthResult> {
  const trace = createOAuthTrace({
    source: "refresh",
    serverName,
  });
  const emitTrace = () =>
    publishOAuthTraceUpdate(serverName, trace, options.onTraceUpdate);
  // Build fetch interceptor — routes token requests through Convex for registry servers
  const oauthConfig = readStoredOAuthConfig(serverName);
  const fetchFn = createOAuthFetchInterceptor(oauthConfig, trace);

  try {
    // Get stored client credentials if any
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;
    const customClientSecret = storedClientInfo
      ? JSON.parse(storedClientInfo).client_secret
      : undefined;

    // Get server URL
    const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      emitTrace();
      return {
        success: false,
        error: "Server URL not found for token refresh",
      };
    }

    const provider = new MCPOAuthProvider(
      serverName,
      serverUrl,
      customClientId,
      customClientSecret
    );
    const existingTokens = provider.tokens();

    if (!existingTokens?.refresh_token) {
      emitTrace();
      return {
        success: false,
        error: "No refresh token available",
        oauthTrace: trace,
      };
    }

    startOAuthTraceStep(trace, "request_resource_metadata", {
      message: "Refreshing OAuth tokens and rediscovering server metadata.",
    });
    emitTrace();
    const discoveryState = await loadCallbackDiscoveryState(
      provider,
      serverUrl,
      fetchFn
    );
    completeOAuthTraceStep(trace, "request_resource_metadata", {
      message: "Protected resource metadata loaded.",
    });
    completeOAuthTraceStep(trace, "received_resource_metadata", {
      message: "Resource metadata is ready.",
    });
    completeOAuthTraceStep(trace, "received_authorization_server_metadata", {
      message: "Authorization server metadata is ready.",
    });
    emitTrace();
    const resource = await selectResourceURL(
      serverUrl,
      provider,
      discoveryState.resourceMetadata
    );
    startOAuthTraceStep(trace, "token_request", {
      message: "Refreshing tokens with the stored refresh token.",
    });
    emitTrace();
    const tokens = await fetchToken(
      provider,
      discoveryState.authorizationServerUrl,
      {
        metadata: discoveryState.authorizationServerMetadata,
        ...(resource ? { resource } : {}),
        fetchFn,
      }
    );
    await provider.saveTokens(tokens);
    completeOAuthTraceStep(trace, "token_request", {
      message: "Refresh token exchange succeeded.",
    });
    completeOAuthTraceStep(trace, "received_access_token", {
      message: "Refreshed OAuth tokens were stored locally.",
    });
    completeOAuthTraceStep(trace, "complete", {
      message: "OAuth token refresh completed successfully.",
    });
    emitTrace();
    const serverConfig = createServerConfig(serverUrl, tokens);
    return {
      success: true,
      serverConfig,
      oauthTrace: trace,
    };
  } catch (error) {
    let errorMessage = "Unknown refresh error";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Provide more helpful error messages for common client ID issues during refresh
      if (
        errorMessage.includes("invalid_client") ||
        errorMessage.includes("client_id")
      ) {
        errorMessage =
          "Invalid client ID during token refresh. The stored client ID may be incorrect.";
      } else if (errorMessage.includes("invalid_grant")) {
        errorMessage =
          "Refresh token invalid or expired. Please re-authenticate with the OAuth provider.";
      } else if (errorMessage.includes("unauthorized_client")) {
        errorMessage =
          "Client not authorized for token refresh. Please re-authenticate.";
      }
    }

    failOAuthTraceStep(trace, trace.currentStep, errorMessage, {
      message: "OAuth token refresh failed.",
    });
    emitTrace();

    return {
      success: false,
      error: errorMessage,
      oauthTrace: trace,
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Clears all OAuth data for a server
 */
export function clearOAuthData(serverName: string): void {
  localStorage.removeItem(`mcp-tokens-${serverName}`);
  localStorage.removeItem(`mcp-client-${serverName}`);
  localStorage.removeItem(`mcp-verifier-${serverName}`);
  localStorage.removeItem(`mcp-serverUrl-${serverName}`);
  localStorage.removeItem(`mcp-oauth-config-${serverName}`);
  clearStoredDiscoveryState(serverName);
  clearOAuthFlowSession(serverName);
  clearOAuthTrace(serverName);
}

/**
 * Creates MCP server configuration with OAuth tokens
 */
export function createServerConfig(
  serverUrl: string,
  tokens?: { access_token?: string | null }
): HttpServerConfig {
  // Note: We don't include authProvider in the config because it can't be serialized
  // when sent to the backend via JSON. The backend will use the Authorization header instead.
  // Token refresh should be handled separately if the token expires.

  return {
    url: serverUrl,
    requestInit: {
      headers: tokens?.access_token
        ? {
            Authorization: `Bearer ${tokens.access_token}`,
          }
        : {},
    },
  };
}
