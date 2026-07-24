/**
 * Production OAuth implementation using the SDK state-machine runner with trace support.
 */

import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  canonicalizeResourceUrl,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  evaluateResourceIndicator,
  exchangeAuthorization,
  fetchToken,
  getBrowserDebugDynamicRegistrationMetadata,
  getSupportedRegistrationStrategies,
  EMPTY_OAUTH_FLOW_STATE,
  isLoopbackOAuthUrl,
  isPrivateHost,
  projectOAuthTraceSnapshot,
  resolveAuthorizationPlan,
  runOAuthStateMachine,
  validateAuthorizationResponseIssuer,
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
import { readIssuerKeyed, writeIssuerKeyed } from "./issuer-keyed-storage";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE, SANITIZE_OAUTH_TRACES } from "@/lib/config";
import {
  importHostedOAuthTokens,
  normalizeImportHostedOAuthTokens,
  type ImportHostedOAuthTokensRequest,
} from "@/lib/apis/hosted-oauth-import-tokens-api";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { captureServerDetailModalOAuthResume } from "@/lib/server-detail-modal-resume";
import { captureCurrentReturnPath } from "@/lib/app-navigation";
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
  clearOAuthTraceSession,
  completeOAuthTraceStep,
  createOAuthTrace,
  failOAuthTraceStep,
  loadOAuthTraceFromSession,
  mergeOAuthTraces,
  saveOAuthTraceToSession,
  startOAuthTraceStep,
  type OAuthTrace,
} from "./oauth-trace";

// Store original fetch for restoration
const originalFetch = window.fetch;

interface StoredOAuthDiscoveryState {
  serverUrl: string;
  discoveryState: OAuthDiscoveryState;
}

const ELECTRON_MCP_CALLBACK_STATE_PREFIX = "electron_mcp:";

interface StoredOAuthClientInformation {
  client_id?: string;
  client_secret?: string;
}

/**
 * Narrows a raw (pre-migration) parsed `mcp-tokens-*` record to a usable token
 * object. Any non-null, non-array object is accepted as an unbound legacy token
 * bag; anything else (string, number, array, null) is rejected. Used by the
 * issuer-keyed token reads so a legacy unkeyed record is returned as UNBOUND
 * compat while a v2 envelope is gated to the exact resolved issuer (SEP-2352).
 */
function parseLegacyStoredTokens(parsed: unknown): any {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : undefined;
}

type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export interface StoredOAuthConfig {
  scopes?: string[];
  customHeaders?: Record<string, string>;
  resourceUrl?: string;
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
  headers: Record<string, string>
): Record<string, string> {
  return SANITIZE_OAUTH_TRACES ? sanitizeOAuthHeaders(headers) : { ...headers };
}

function traceOAuthValue(value: unknown): unknown {
  return SANITIZE_OAUTH_TRACES ? sanitizeOAuthTraceValue(value) : value;
}

function parseOAuthResponseText(text: string, contentType: string): unknown {
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
    clientSecret: undefined,
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
        parsed.protocolVersion !== "2025-11-25" &&
        parsed.protocolVersion !== "2026-07-28")
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
  options: Pick<MCPOAuthOptions, "protocolMode" | "protocolVersion">
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
    | "hasClientSecret"
    | "useRegistryOAuthProxy"
  >
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
    options.clientSecret ||
    options.hasClientSecret
  ) {
    return "preregistered";
  }

  return "auto";
}

function createScopedDiscoveryFetch(
  fetchFn: typeof fetch,
  serverUrl: string,
  customHeaders?: Record<string, string>
): typeof fetch {
  if (!customHeaders || Object.keys(customHeaders).length === 0) {
    return fetchFn;
  }

  let serverOrigin: string;
  try {
    serverOrigin = new URL(serverUrl).origin;
  } catch {
    return fetchFn;
  }

  return (input, init) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

    let requestOrigin: string;
    try {
      requestOrigin = new URL(requestUrl, serverUrl).origin;
    } catch {
      return fetchFn(input, init);
    }

    if (requestOrigin !== serverOrigin) {
      return fetchFn(input, init);
    }

    const headers = new Headers(init?.headers ?? undefined);
    for (const [key, value] of Object.entries(customHeaders)) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    return fetchFn(input, {
      ...init,
      headers,
    });
  };
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
    | "hasClientSecret"
    | "useRegistryOAuthProxy"
    | "customHeaders"
  >
): Promise<ResolvedAuthorizationPlan> {
  const basePlan = resolveAuthorizationPlan({
    serverUrl: options.serverUrl,
    protocolMode: resolveOAuthProtocolMode(options),
    protocolVersion: options.protocolVersion,
    registrationMode: resolveOAuthRegistrationMode(options),
    registrationStrategy: options.registrationStrategy,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    hasClientSecret: options.hasClientSecret,
    useRegistryOAuthProxy: options.useRegistryOAuthProxy,
    authMode: "interactive",
  });

  if (
    basePlan.status !== "discovery_required" &&
    basePlan.registrationStrategy !== "preregistered"
  ) {
    return basePlan;
  }

  const discoveryState = await loadCallbackDiscoveryState(
    provider,
    options.serverUrl,
    fetchFn,
    options.customHeaders
  );

  return resolveAuthorizationPlan({
    serverUrl: options.serverUrl,
    protocolMode: resolveOAuthProtocolMode(options),
    protocolVersion: options.protocolVersion,
    registrationMode: resolveOAuthRegistrationMode(options),
    registrationStrategy: options.registrationStrategy,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    hasClientSecret: options.hasClientSecret,
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
  response: Response
): Promise<HttpHistoryEntry["response"]> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: traceOAuthHeaders(Object.fromEntries(response.headers.entries())),
    body: await readResponseBodyForTrace(response),
  };
}

function createTraceResponseFromResult(
  result: Pick<OAuthRequestResult, "status" | "statusText" | "headers" | "body">
): HttpHistoryEntry["response"] {
  return {
    status: result.status,
    statusText: result.statusText,
    headers: traceOAuthHeaders(result.headers ?? {}),
    body: traceOAuthValue(result.body),
  };
}

/**
 * Defense-in-depth against redirect-based SSRF. The browser fetch has ALREADY
 * followed any redirects and contacted the destination by the time we see the
 * response, so this does NOT prevent the network request — it prevents the
 * OAuth flow from CONSUMING a response whose final URL is a private/reserved
 * host, and routes retryable cases through the DNS-pinning proxy. It also can't
 * detect a public hostname that DNS-resolves to a private address (that is the
 * proxy's job). Re-validate the FINAL URL against the factory guard's policy;
 * an empty/opaque URL can't be inspected and is left to the normal flow.
 */
function assertFinalResponseUrlAllowed(finalUrl: string | undefined): void {
  if (!finalUrl) return;
  let host: string;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    return;
  }
  if (isPrivateHost(host)) {
    throw new Error(
      `Refusing OAuth response from private/reserved host "${host}" (possible SSRF via redirect)`
    );
  }
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
      // SSRF defense-in-depth: the factory guard validated the INITIAL url. The
      // fetch may have already followed a redirect to a private host; reject
      // CONSUMING that response (a private final URL throws → proxy retry / fail
      // closed). Does not stop the request itself; DNS-rebind is the proxy's job.
      assertFinalResponseUrlAllowed(directResponse.url);
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

  if (typeof state.state === "string" && state.state) {
    provider.saveIssuedCallbackState(state.state);
  }

  // Persist discovery (incl. authorizationServerUrl) BEFORE saveTokens: the
  // hosted-OAuth import inside saveTokens reads the AS URL from discoveryState()
  // (localStorage), so it must already be written or the import omits it and a
  // later hosted refresh can't reach localhost servers to rediscover it.
  await saveDiscoveryStateFromFlowState(provider, state);

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

function formatAuthorizationStrategyLabel(
  strategy: OAuthRegistrationStrategy
): string {
  switch (strategy) {
    case "preregistered":
      return "pre-registered credentials";
    case "cimd":
      return "CIMD";
    case "dcr":
      return "DCR";
  }
}

function formatSupportedStrategyLabel(
  strategy: "preregistered" | "cimd" | "dcr"
): string {
  switch (strategy) {
    case "preregistered":
      return "Pre-registered";
    case "cimd":
      return "CIMD";
    case "dcr":
      return "DCR";
  }
}

function buildAutomaticAuthorizationDecisionReason(
  plan: ResolvedAuthorizationPlan
): string | undefined {
  switch (plan.registrationStrategy) {
    case "preregistered":
      return "Client credentials were already available, so automatic mode did not need CIMD or DCR.";
    case "cimd":
      return plan.capabilities.supportsDcr
        ? "The authorization server advertised client_id_metadata_document_supported, so automatic mode preferred CIMD over DCR."
        : "The authorization server advertised client_id_metadata_document_supported.";
    case "dcr":
      if (
        !getSupportedRegistrationStrategies(plan.protocolVersion).includes(
          "cimd"
        )
      ) {
        return `CIMD is not available for protocol version ${plan.protocolVersion}, so automatic mode used DCR.`;
      }

      if (!plan.capabilities.supportsCimd) {
        return "The authorization server advertised registration_endpoint, and CIMD support was not advertised.";
      }

      return "The authorization server advertised registration_endpoint.";
    default:
      return undefined;
  }
}

function annotateTraceWithAuthorizationPlan(input: {
  trace: OAuthTrace;
  authorizationPlan?: ResolvedAuthorizationPlan;
  requestedRegistrationMode: OAuthRegistrationMode;
}): OAuthTrace {
  const { trace, authorizationPlan, requestedRegistrationMode } = input;
  if (
    requestedRegistrationMode !== "auto" ||
    !authorizationPlan ||
    authorizationPlan.status !== "ready" ||
    !authorizationPlan.registrationStrategy
  ) {
    return trace;
  }

  const targetStepPriority = [
    "received_authorization_server_metadata",
    "authorization_request",
    "received_client_credentials",
    "request_client_registration",
  ] as const;
  let targetStepIndex: number | undefined;
  for (const stepName of targetStepPriority) {
    const index = trace.steps.findIndex((step) => step.step === stepName);
    if (index >= 0) {
      targetStepIndex = index;
      break;
    }
  }
  if (targetStepIndex == null || targetStepIndex === -1) {
    return trace;
  }

  const targetStep = trace.steps[targetStepIndex];
  const selectedStrategyLabel = formatAuthorizationStrategyLabel(
    authorizationPlan.registrationStrategy
  );
  const reason = buildAutomaticAuthorizationDecisionReason(authorizationPlan);
  const supportedStrategies =
    authorizationPlan.capabilities.registrationStrategies.length > 0
      ? authorizationPlan.capabilities.registrationStrategies.map(
          formatSupportedStrategyLabel
        )
      : undefined;

  const nextMessage = [
    `Automatic resolved to ${selectedStrategyLabel} for this run.`,
    reason,
  ]
    .filter(Boolean)
    .join(" ");
  const nextDetails = {
    ...(targetStep.details ?? {}),
    "Automatic Decision": selectedStrategyLabel,
    ...(supportedStrategies
      ? {
          "Advertised Strategies": supportedStrategies.join(", "),
        }
      : {}),
    ...(reason ? { Reason: reason } : {}),
    ...(authorizationPlan.registrationStrategy === "dcr" &&
    !authorizationPlan.capabilities.supportsCimd
      ? {
          "CIMD Support": "Not advertised by authorization server",
        }
      : {}),
  };

  return {
    ...trace,
    steps: trace.steps.map((step, index) =>
      index === targetStepIndex
        ? {
            ...step,
            message: nextMessage,
            details: nextDetails,
          }
        : step
    ),
  };
}

export function readStoredOAuthConfig(
  serverName: string | null
): StoredOAuthConfig {
  if (!serverName || HOSTED_MODE) {
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
      resourceUrl:
        typeof parsed?.resourceUrl === "string" &&
        parsed.resourceUrl.trim() !== ""
          ? parsed.resourceUrl
          : undefined,
      protocolMode:
        parsed?.protocolMode === "auto" ||
        parsed?.protocolMode === "2025-03-26" ||
        parsed?.protocolMode === "2025-06-18" ||
        parsed?.protocolMode === "2025-11-25" ||
        parsed?.protocolMode === "2026-07-28"
          ? parsed.protocolMode
          : undefined,
      protocolVersion:
        parsed?.protocolVersion === "2025-03-26" ||
        parsed?.protocolVersion === "2025-06-18" ||
        parsed?.protocolVersion === "2025-11-25" ||
        parsed?.protocolVersion === "2026-07-28"
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
  } catch (e) {
    console.warn('[mcp-oauth] Failed to parse stored OAuth config', e);
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
    | "resourceUrl"
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

  if (options.resourceUrl?.trim()) {
    config.resourceUrl = options.resourceUrl.trim();
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
  fetchFn: typeof fetch,
  customHeaders?: Record<string, string>
): Promise<OAuthDiscoveryState> {
  const discoveryFetch = createScopedDiscoveryFetch(
    fetchFn,
    serverUrl,
    customHeaders
  );
  const cachedState = await provider.discoveryState();
  if (cachedState?.authorizationServerUrl) {
    const authorizationServerMetadata =
      cachedState.authorizationServerMetadata ??
      (await discoverAuthorizationServerMetadata(
        cachedState.authorizationServerUrl,
        { fetchFn: discoveryFetch }
      ));

    const discoveryState: OAuthDiscoveryState = {
      ...cachedState,
      authorizationServerMetadata,
    };
    await provider.saveDiscoveryState(discoveryState);
    return discoveryState;
  }

  const discovered = await discoverOAuthServerInfo(serverUrl, {
    fetchFn: discoveryFetch,
  });
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
  resourceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
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
  oauthResourceUrl?: string;
}

export function buildMCPOAuthState(): string {
  const state = generateRandomString(32);
  if (window.isElectron) {
    return `${ELECTRON_MCP_CALLBACK_STATE_PREFIX}${state}`;
  }
  return state;
}

export function isElectronMcpCallbackState(
  state: string | null | undefined,
): boolean {
  return Boolean(state && state.startsWith(ELECTRON_MCP_CALLBACK_STATE_PREFIX));
}

function tagElectronMcpCallbackState(state: string | null | undefined): string {
  if (isElectronMcpCallbackState(state)) {
    return state!;
  }

  return `${ELECTRON_MCP_CALLBACK_STATE_PREFIX}${
    state || generateRandomString(32)
  }`;
}

function buildElectronMcpAuthorizationRequest(authorizationUrl: string): {
  authorizationUrl: string;
  state?: string;
} {
  if (typeof window === "undefined" || !window.isElectron) {
    return { authorizationUrl };
  }

  try {
    const url = new URL(authorizationUrl);
    const state = tagElectronMcpCallbackState(url.searchParams.get("state"));
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), state };
  } catch {
    return { authorizationUrl };
  }
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

function readOAuthResourceFromAuthorizationUrl(
  authorizationUrl?: string
): string | undefined {
  if (!authorizationUrl) {
    return undefined;
  }

  try {
    const url = new URL(authorizationUrl);
    const resource = url.searchParams.get("resource")?.trim();
    return resource || undefined;
  } catch {
    return undefined;
  }
}

function readOAuthResourceFromMetadata(
  resourceMetadata?: { resource?: unknown } | null
): string | undefined {
  const resource =
    typeof resourceMetadata?.resource === "string"
      ? resourceMetadata.resource.trim()
      : "";
  return resource || undefined;
}

const RESOURCE_INDICATOR_SOURCE_LABELS: Record<string, string> = {
  prm: "protected resource metadata",
  authorization: "authorization URL",
};

/**
 * Resolve the RFC 8707 resource indicator through the SDK's shared policy
 * (`evaluateResourceIndicator`) so Quick OAuth sends the exact value the
 * debugger, oauth-login, and conformance surfaces send.
 *
 * Quick OAuth is a connect surface, so server-supplied candidates (PRM, a
 * previously built authorization URL) are rejected when they are invalid or
 * cross-origin — honoring an arbitrary origin would let a compromised server
 * steer tokens to a different audience. Same-origin values that merely fail
 * the official SDK's path-prefix binding stay accepted (real servers like
 * Asana advertise them; `strictClientCompatible` reports the gap). A
 * caller-configured override stays trusted (it is user-, not
 * server-supplied) and is only canonicalized, matching historical behavior.
 */
function resolveOAuthResourceUrl(input: {
  serverUrl: string;
  authorizationUrl?: string;
  configuredResourceUrl?: string;
  resourceMetadata?: { resource?: unknown } | null;
}): string {
  const prmResource = readOAuthResourceFromMetadata(input.resourceMetadata);

  // A PRM document that exists but omits its REQUIRED `resource` (RFC 9728
  // §2) is broken metadata — silently falling through to another candidate
  // would connect against metadata every other connect surface rejects.
  if (input.resourceMetadata && !prmResource) {
    throw new Error(
      'Rejected OAuth resource indicator from protected resource metadata: the document is missing its required "resource" identifier (RFC 9728 §2).'
    );
  }

  const decision = evaluateResourceIndicator({
    serverUrl: input.serverUrl,
    prmResource,
    authorizationUrlResource: readOAuthResourceFromAuthorizationUrl(
      input.authorizationUrl
    ),
    configuredResource: input.configuredResourceUrl,
  });

  if (decision.status === "valid") {
    // Server-advertised values (prm/authorization) are echoed verbatim — the
    // AS compares against what was advertised. User-typed configured
    // overrides (and the server fallback) are canonicalized, matching
    // historical behavior for stored variants like a trailing slash.
    return decision.source === "configured"
      ? canonicalizeResourceUrl(decision.value)
      : decision.value;
  }

  const sourceLabel = RESOURCE_INDICATOR_SOURCE_LABELS[decision.source];
  if (sourceLabel) {
    throw new Error(
      `Rejected OAuth resource indicator from ${sourceLabel}: ${
        decision.reason ?? "failed validation against the server URL"
      }`
    );
  }

  return canonicalizeResourceUrl(decision.value);
}

/**
 * Stamp `?resource=<resourceUrl>` onto an authorization URL so the AS knows
 * which audience to mint the token for (RFC 8707 / MCP OAuth profile).
 * Without this, the AS issues tokens with a default `aud` that the resource
 * server may reject.
 */
function withOAuthResourceParam(
  authorizationUrl: string,
  resourceUrl: string
): string {
  try {
    const url = new URL(authorizationUrl);
    url.searchParams.set("resource", resourceUrl);
    return url.toString();
  } catch {
    return authorizationUrl;
  }
}

function writeStoredOAuthConfig(
  serverName: string,
  updates: Partial<StoredOAuthConfig>
): void {
  const existing = readStoredOAuthConfig(serverName);
  localStorage.setItem(
    `mcp-oauth-config-${serverName}`,
    JSON.stringify({
      ...existing,
      ...updates,
    })
  );
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
  authorizationUrl?: string;
  configuredResourceUrl?: string;
}): Promise<string | undefined> {
  if (!HOSTED_MODE) {
    return undefined;
  }

  const pendingMarker = readHostedOAuthPendingMarker();
  if (
    !pendingMarker?.projectId ||
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
  const oauthResourceUrl = resolveOAuthResourceUrl({
    serverUrl: input.serverUrl,
    authorizationUrl: input.authorizationUrl ?? input.state.authorizationUrl,
    configuredResourceUrl: input.configuredResourceUrl,
    resourceMetadata: input.state.resourceMetadata as
      | { resource?: unknown }
      | undefined,
  });

  const response = await authFetch("/api/web/oauth/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: pendingMarker.projectId,
      serverId: pendingMarker.serverId,
      codeVerifier,
      redirectUri: input.redirectUrl,
      expectedState,
      oauthResourceUrl,
      clientInformation: {
        clientId,
        ...(input.state.clientSecret
          ? { clientSecret: input.state.clientSecret }
          : {}),
      },
      ...(pendingMarker.accessScope
        ? { accessScope: pendingMarker.accessScope }
        : {}),
      ...(pendingMarker.chatboxId
        ? { chatboxId: pendingMarker.chatboxId }
        : {}),
      ...(pendingMarker.chatboxId &&
      typeof pendingMarker.accessVersion === "number" &&
      Number.isFinite(pendingMarker.accessVersion)
        ? { accessVersion: pendingMarker.accessVersion }
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
      result?.error || `OAuth session failed (${response.status})`
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
  authorizationHeader?: string | null;
}): Promise<HostedOAuthSessionProgressResponse | null> {
  if (
    !input.context.projectId ||
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
        ...(input.authorizationHeader
          ? { Authorization: input.authorizationHeader }
          : {}),
      },
      body: JSON.stringify({
        projectId: input.context.projectId,
        serverId: input.context.serverId,
        sessionId: input.context.sessionId,
        ...(input.context.accessScope
          ? { accessScope: input.context.accessScope }
          : {}),
        ...(input.context.chatboxId
          ? { chatboxId: input.context.chatboxId }
          : {}),
        ...(input.context.chatboxId &&
        typeof input.context.accessVersion === "number" &&
        Number.isFinite(input.context.accessVersion)
          ? { accessVersion: input.context.accessVersion }
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
 * Browser OAuth provider for MCP
 */
/**
 * Optional Convex binding threaded through to `saveTokens` so that — in local
 * mode — pre-exchanged OAuth tokens get imported into the Convex
 * `hostedOAuthCredentials` store via `/api/web/oauth/import-tokens`. Without
 * a binding, `saveTokens` rejects instead of storing tokens in localStorage.
 *
 * `kind` is `"registry"` iff BOTH `registryServerId` AND `useRegistryOAuthProxy`
 * are set on the originating flow; a stored `registryServerId` alone does not
 * imply registry-managed tokens.
 */
export interface MCPOAuthProviderConvexBinding {
  projectId: string;
  serverId: string;
  oauthResourceUrl?: string;
  kind: "generic" | "registry";
  hasClientSecret?: boolean;
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
}

export class MCPOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private serverUrl: string;
  private redirectUri: string;
  private customClientId?: string;
  private customClientSecret?: string;
  private convexBinding?: MCPOAuthProviderConvexBinding;
  private runtimeClientSecret?: string;
  private storedClientSecretPromise?: Promise<string | undefined>;

  constructor(
    serverName: string,
    serverUrl: string,
    customClientId?: string,
    customClientSecret?: string,
    convexBinding?: MCPOAuthProviderConvexBinding
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.redirectUri = getRedirectUri();
    this.customClientId = customClientId;
    this.customClientSecret = customClientSecret;
    this.convexBinding = convexBinding;
  }

  state(): string {
    return buildMCPOAuthState();
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata() {
    // When the user has supplied a static client_secret we register as a
    // confidential client; otherwise PKCE-only ("none"). Advertising "none"
    // with a secret would tell the server to expect no creds at the token
    // endpoint and the SDK would honor that hint on later exchanges,
    // silently dropping the secret and producing `invalid_client`.
    const hasSecret = Boolean(
      this.customClientSecret || this.convexBinding?.hasClientSecret
    );
    return {
      client_name: `MCPJam - ${this.serverName}`,
      client_uri: "https://github.com/mcpjam/inspector",
      logo_uri: "https://www.mcpjam.com/mcp_jam_2row.png",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: hasSecret ? "client_secret_basic" : "none",
    };
  }

  /**
   * The exact authorization-server issuer for the active flow, sourced
   * best-effort so client-info/token storage can be BOUND to it (SEP-2352):
   * persisted discovery first, then the in-flight OAuth session's recorded
   * issuer. Undefined only before any AS discovery has resolved — in which
   * case storage stays unkeyed and is promoted on the next issuer-stamped save.
   */
  private currentIssuer(): string | undefined {
    // Delegate to the standalone resolver so the provider and the bootstrap
    // reads/writes share one issuer-resolution rule (no drift).
    return resolveStoredIssuer(this.serverName, this.serverUrl);
  }

  private readStoredClientInformation(): Record<string, any> | undefined {
    const raw = localStorage.getItem(`mcp-client-${this.serverName}`);
    const issuer = this.currentIssuer();
    const { value } = readIssuerKeyed<Record<string, any>>(
      raw,
      issuer,
      (parsed) =>
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, any>)
          : undefined
    );
    if (!value || typeof value !== "object") {
      return undefined;
    }
    // Defense-in-depth: a client_secret must never persist on disk. If a legacy
    // record still carries one, strip and re-persist (keyed when the issuer is
    // known, else unkeyed until the next issuer-stamped save promotes it).
    if ("client_secret" in value) {
      const stripped = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "client_secret")
      );
      localStorage.setItem(
        `mcp-client-${this.serverName}`,
        JSON.stringify(issuer ? writeIssuerKeyed(raw, issuer, stripped) : stripped)
      );
      return stripped;
    }
    return value;
  }

  private async loadStoredClientSecret(): Promise<string | undefined> {
    if (this.customClientSecret) {
      return this.customClientSecret;
    }
    if (this.runtimeClientSecret) {
      return this.runtimeClientSecret;
    }
    if (!this.convexBinding?.hasClientSecret) {
      return undefined;
    }
    if (!this.storedClientSecretPromise) {
      this.storedClientSecretPromise = fetchOAuthClientSecret({
        projectId: this.convexBinding.projectId,
        serverId: this.convexBinding.serverId,
      })
        .then((result) => result.clientSecret)
        .catch((error) => {
          this.storedClientSecretPromise = undefined;
          throw error;
        });
    }
    return this.storedClientSecretPromise;
  }

  async clientInformation() {
    const storedClientInformation = this.readStoredClientInformation();
    const clientSecret = await this.loadStoredClientSecret();

    // If custom client ID is provided, use it
    if (this.customClientId) {
      if (storedClientInformation) {
        // If there's stored information, merge with custom client credentials
        const result: any = {
          ...storedClientInformation,
          client_id: this.customClientId,
        };
        // Add client secret if provided
        if (clientSecret) {
          result.client_secret = clientSecret;
          // Drop only the specific `"none"` hint inherited from a prior
          // DCR registration. Our DCR metadata advertises "none" when no
          // secret is set, and servers echo that back into the stored
          // client info. The upstream SDK's `selectClientAuthMethod`
          // honors the field when present, so leaving "none" here would
          // silently bypass the secret on token exchange and surface as
          // `invalid_client`. Stored `client_secret_basic` / `_post` are
          // left intact — they may be a legitimate per-client registration
          // value, and either still results in the secret being sent.
          if (result.token_endpoint_auth_method === "none") {
            delete result.token_endpoint_auth_method;
          }
        }
        return result;
      } else {
        // If no stored information, create a minimal client info with custom credentials
        const result: any = {
          client_id: this.customClientId,
        };
        if (clientSecret) {
          result.client_secret = clientSecret;
        }
        return result;
      }
    }
    if (storedClientInformation && clientSecret) {
      const result: any = {
        ...storedClientInformation,
        client_secret: clientSecret,
      };
      if (result.token_endpoint_auth_method === "none") {
        delete result.token_endpoint_auth_method;
      }
      return result;
    }
    return storedClientInformation;
  }

  async saveClientInformation(clientInformation: any) {
    if (typeof clientInformation?.client_secret === "string") {
      this.runtimeClientSecret = clientInformation.client_secret;
    }
    const clientInformationToStore =
      clientInformation && typeof clientInformation === "object"
        ? Object.fromEntries(
            Object.entries(clientInformation).filter(
              ([key]) => key !== "client_secret"
            )
          )
        : clientInformation;
    // SEP-2352: bind the registration to the exact issuer that granted it.
    // When the issuer is resolved, persist issuer-keyed (a later AS change then
    // gets its own bucket — an AS-A client id is never reused for AS B). Before
    // any AS discovery, store unkeyed; the next issuer-stamped save promotes it.
    const issuer = this.currentIssuer();
    const raw = localStorage.getItem(`mcp-client-${this.serverName}`);
    localStorage.setItem(
      `mcp-client-${this.serverName}`,
      JSON.stringify(
        issuer
          ? writeIssuerKeyed(raw, issuer, clientInformationToStore)
          : clientInformationToStore
      )
    );
  }

  tokens() {
    // SEP-2352: return only the token bucket bound to the EXACT resolved issuer.
    // A v2-keyed envelope for AS A yields nothing once discovery resolves to
    // AS B, so AS A's tokens are never presented to AS B (mirrors the client-id
    // read). Legacy unkeyed records — the only shape written today; see the
    // `saveTokens` note on Convex being the token source of truth — are returned
    // as UNBOUND compat so existing local logins and the refresh path keep
    // working. Before any AS is resolved, `readIssuerKeyed` falls back to the
    // envelope's active bucket (or the legacy value), preserving refresh.
    const raw = localStorage.getItem(`mcp-tokens-${this.serverName}`);
    const { value } = readIssuerKeyed<any>(
      raw,
      this.currentIssuer(),
      parseLegacyStoredTokens
    );
    return value;
  }

  async saveTokens(tokens: any) {
    if (HOSTED_MODE) {
      return;
    }

    const normalizedTokens = normalizeImportHostedOAuthTokens(tokens);
    if (!normalizedTokens) {
      localStorage.removeItem(`mcp-tokens-${this.serverName}`);
      throw new Error(
        "OAuth token response missing access_token; cannot import tokens to Convex"
      );
    }
    if (!this.convexBinding) {
      localStorage.removeItem(`mcp-tokens-${this.serverName}`);
      throw new Error(
        "OAuth server is not synced; cannot store tokens securely"
      );
    }

    const stored = await this.clientInformation();
    const clientId =
      (stored?.client_id as string | undefined) ?? this.customClientId;
    if (!clientId) {
      localStorage.removeItem(`mcp-tokens-${this.serverName}`);
      // No clientId means we can't write a usable record; bail loudly so
      // the OAuth-completion error surfaces in the UI rather than 401ing
      // silently on the next connect.
      throw new Error(
        "OAuth client information missing client_id; cannot import tokens to Convex"
      );
    }
    const clientSecret =
      (stored?.client_secret as string | undefined) ?? this.customClientSecret;
    // Forward the AS URL we discovered locally so the hosted backend can
    // persist a refresh fallback for servers it can't reach (e.g. localhost);
    // without it, the backend re-discovers against an unreachable resource on
    // refresh and the credential becomes unusable.
    const authorizationServerUrl = this.discoveryState()?.authorizationServerUrl;
    const importPayload: ImportHostedOAuthTokensRequest = {
      projectId: this.convexBinding.projectId,
      serverId: this.convexBinding.serverId,
      serverUrl: this.serverUrl,
      ...(this.convexBinding.oauthResourceUrl
        ? { oauthResourceUrl: this.convexBinding.oauthResourceUrl }
        : {}),
      ...(authorizationServerUrl ? { authorizationServerUrl } : {}),
      kind: this.convexBinding.kind,
      ...(this.convexBinding.registryServerId
        ? { registryServerId: this.convexBinding.registryServerId }
        : {}),
      ...(this.convexBinding.useRegistryOAuthProxy
        ? { useRegistryOAuthProxy: this.convexBinding.useRegistryOAuthProxy }
        : {}),
      clientInformation: {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      },
      tokens: normalizedTokens,
    };
    await importHostedOAuthTokens(importPayload);
    localStorage.removeItem(`mcp-tokens-${this.serverName}`);
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
    return loadStoredDiscoveryState(this.serverName, this.serverUrl);
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
    const authorizationUrlString = authorizationUrl.toString();
    captureServerDetailModalOAuthResume(this.serverName);
    // Store server name for callback recovery
    localStorage.setItem("mcp-oauth-pending", this.serverName);
    // Store the current route to restore after OAuth callback.
    const returnTarget = captureCurrentReturnPath();
    if (returnTarget) {
      // Key name is retained for in-flight migration compatibility; values are
      // now path targets.
      localStorage.setItem("mcp-oauth-return-hash", returnTarget);
    }

    if (window.isElectron) {
      if (window.electronAPI?.app?.openExternal) {
        try {
          await window.electronAPI.app.openExternal(authorizationUrlString);
          return;
        } catch (error) {
          console.warn(
            "Failed to open system browser for MCP OAuth; continuing inside MCPJam Desktop:",
            error,
          );
        }
      } else {
        console.warn(
          "System browser opener is unavailable for MCP OAuth; continuing inside MCPJam Desktop.",
        );
      }

      this.navigateToUrl(authorizationUrlString);
      return;
    }

    this.navigateToUrl(authorizationUrlString);
  }

  navigateToUrl(url: string) {
    window.location.assign(url);
  }

  async saveCodeVerifier(codeVerifier: string) {
    localStorage.setItem(`mcp-verifier-${this.serverName}`, codeVerifier);
  }

  // 2R-iss / review F6: the issued CSRF `state` persisted durably (like the
  // verifier), so the no-stored-session callback fallback can still recover and
  // validate it after the flow session is lost, instead of redeeming blindly.
  saveIssuedCallbackState(state: string) {
    localStorage.setItem(`mcp-oauth-issued-state-${this.serverName}`, state);
  }

  issuedCallbackState(): string | undefined {
    return (
      localStorage.getItem(`mcp-oauth-issued-state-${this.serverName}`) ??
      undefined
    );
  }

  clearIssuedCallbackState() {
    localStorage.removeItem(`mcp-oauth-issued-state-${this.serverName}`);
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

/**
 * Persisted Convex binding so `handleOAuthCallback` can recover the
 * projectId/serverId mapping after the OAuth redirect, when the in-memory
 * `apiContext.serverIdsByName` hasn't been repopulated yet (the Convex
 * `getProjectServers` query is still inflight on the post-redirect mount).
 *
 * Without this persisted copy `saveTokens` skips the Convex
 * `hostedOAuthCredentials` write and the next `/api/mcp/connect` 401s with
 * "Server requires OAuth authentication" because `authorize-batch-local`
 * can't find the credential row. Cleared with the rest of the per-server
 * OAuth state in `clearOAuthData`.
 */
const oauthBindingStorage = {
  storageKey(serverName: string): string {
    return `mcp-oauth-binding-${serverName}`;
  },
  get(serverName: string): MCPOAuthProviderConvexBinding | undefined {
    if (typeof window === "undefined") return undefined;
    try {
      const raw = localStorage.getItem(this.storageKey(serverName));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<MCPOAuthProviderConvexBinding>;
      if (
        typeof parsed?.projectId !== "string" ||
        typeof parsed?.serverId !== "string"
      ) {
        return undefined;
      }
      if (parsed.kind !== "generic" && parsed.kind !== "registry") {
        return undefined;
      }
      return parsed as MCPOAuthProviderConvexBinding;
    } catch {
      return undefined;
    }
  },
  set(serverName: string, binding: MCPOAuthProviderConvexBinding): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(
        this.storageKey(serverName),
        JSON.stringify(binding)
      );
    } catch {
      // best-effort — if the persisted binding is missing, the only
      // downside of a missed persist is that the post-redirect callback
      // can't import to Convex and the user re-OAuths after expiry.
    }
  },
  clear(serverName: string): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(this.storageKey(serverName));
    } catch {
      // best-effort
    }
  },
};

/**
 * Build the Convex binding to thread into `MCPOAuthProvider` so that
 * `saveTokens` mirrors the issued tokens to the Convex `hostedOAuthCredentials`
 * store. Tries in-memory `apiContext` first (the populated common case at
 * `initiateOAuth` time); falls back to the localStorage-persisted binding
 * written at initiation so post-redirect callbacks can still resolve the
 * mapping while `getProjectServers` is still loading. Returns undefined
 * only when both lookups fail; `saveTokens` treats that as an unsafe token
 * storage path and rejects.
 */
function buildConvexBindingForServer(input: {
  serverName: string;
  oauthResourceUrl?: string;
  hasClientSecret?: boolean;
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
}): MCPOAuthProviderConvexBinding | undefined {
  if (HOSTED_MODE) return undefined;
  const previousBinding = oauthBindingStorage.get(input.serverName);
  const resolved = tryResolveProjectServer(input.serverName);
  if (resolved) {
    const isRegistry =
      !!input.registryServerId && input.useRegistryOAuthProxy === true;
    const hasClientSecret =
      input.hasClientSecret ?? previousBinding?.hasClientSecret;
    const binding: MCPOAuthProviderConvexBinding = {
      projectId: resolved.projectId,
      serverId: resolved.serverId,
      ...(input.oauthResourceUrl
        ? { oauthResourceUrl: input.oauthResourceUrl }
        : {}),
      kind: isRegistry ? "registry" : "generic",
      ...(hasClientSecret ? { hasClientSecret: true } : {}),
      ...(isRegistry
        ? {
            registryServerId: input.registryServerId,
            useRegistryOAuthProxy: true,
          }
        : {}),
    };
    // Persist so the post-redirect callback can recover this mapping even
    // if apiContext.serverIdsByName hasn't repopulated yet.
    oauthBindingStorage.set(input.serverName, binding);
    return binding;
  }
  return previousBinding;
}

/**
 * Constructs an `MCPOAuthProvider` with its Convex binding pre-resolved.
 * The three OAuth flow entry points (`initiateOAuth`, `handleOAuthCallback`,
 * `refreshOAuthTokens`) all need an identical instance shape; this factory
 * keeps that wiring in one place so adding a constructor argument doesn't
 * require touching three call sites.
 */
function createMCPOAuthProvider(input: {
  serverName: string;
  serverUrl: string;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  oauthConfig: {
    resourceUrl?: string;
    registryServerId?: string;
    useRegistryOAuthProxy?: boolean;
  };
}): MCPOAuthProvider {
  return new MCPOAuthProvider(
    input.serverName,
    input.serverUrl,
    input.clientId,
    input.clientSecret,
    buildConvexBindingForServer({
      serverName: input.serverName,
      oauthResourceUrl: input.oauthConfig.resourceUrl,
      hasClientSecret: input.clientSecret ? true : input.hasClientSecret,
      registryServerId: input.oauthConfig.registryServerId,
      useRegistryOAuthProxy: input.oauthConfig.useRegistryOAuthProxy,
    })
  );
}

/**
 * Standalone twin of `MCPOAuthProvider.discoveryState()` — reads the persisted
 * discovery state for a server, validating the stored `serverUrl` when the
 * caller can supply it.
 */
function loadStoredDiscoveryState(
  serverName: string,
  serverUrl?: string
): OAuthDiscoveryState | undefined {
  const stored = localStorage.getItem(getDiscoveryStorageKey(serverName));
  if (!stored) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<StoredOAuthDiscoveryState>;
    if (
      (serverUrl !== undefined && parsed?.serverUrl !== serverUrl) ||
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

/**
 * Standalone twin of `MCPOAuthProvider.currentIssuer()` — resolve the exact
 * authorization-server issuer this server's flow is bound to (persisted
 * discovery first, then the in-flight session's recorded issuer). Returns
 * undefined before any AS is resolved; callers must NOT fall back to a stored
 * envelope's `activeIssuer`, which may be a stale AS after a PRM change.
 */
function resolveStoredIssuer(
  serverName: string,
  serverUrl?: string
): string | undefined {
  const discovery = loadStoredDiscoveryState(serverName, serverUrl);
  const fromDiscovery =
    (discovery?.authorizationServerMetadata as { issuer?: string } | undefined)
      ?.issuer ?? discovery?.authorizationServerUrl;
  if (fromDiscovery) {
    return fromDiscovery;
  }
  const session = loadOAuthFlowSession(serverName);
  return (
    session?.state.recordedIssuer ??
    session?.state.authorizationServerMetadata?.issuer
  );
}

function readStoredClientInformation(
  serverName: string,
  serverUrl?: string
): StoredOAuthClientInformation {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    // Bind the read to the exact resolved issuer. Without a resolved issuer we
    // must NOT fall back to the envelope's `activeIssuer` bucket: after a PRM
    // change that bucket is a different AS's credential, and returning it here
    // would let it override the provider's exact-issuer lookup as a bootstrapped
    // `customClientId` (SEP-2352). The provider's own issuer-keyed
    // `clientInformation()` supplies the client once discovery resolves.
    const issuer = resolveStoredIssuer(serverName, serverUrl);
    if (!issuer) {
      return {};
    }
    const { value, legacyUnbound } = readIssuerKeyed<Record<string, unknown>>(
      raw,
      issuer,
      (parsed) =>
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : undefined
    );
    if (!value || typeof value !== "object") {
      return {};
    }
    // Purge a secret lingering in a legacy (unkeyed) record. Keyed saves
    // already strip, so only the legacy form needs in-place sanitization.
    if (legacyUnbound && "client_secret" in value) {
      const sanitized = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "client_secret")
      );
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify(sanitized)
      );
      return {
        client_id:
          typeof sanitized.client_id === "string"
            ? (sanitized.client_id as string)
            : undefined,
      };
    }
    return {
      client_id:
        typeof value.client_id === "string"
          ? (value.client_id as string)
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
  const requestedProtocolMode = resolveOAuthProtocolMode(options);
  const requestedRegistrationMode = resolveOAuthRegistrationMode(options);
  let traceAuthorizationPlan: ResolvedAuthorizationPlan | undefined;
  const emitTraceSnapshot = (snapshot: OAuthTraceSnapshot) =>
    publishOAuthTraceUpdate(
      options.serverName,
      annotateTraceWithAuthorizationPlan({
        trace: buildOAuthTraceFromSnapshot({
          source: "interactive_connect",
          serverName: options.serverName,
          serverUrl: options.serverUrl,
          snapshot,
        }),
        authorizationPlan: traceAuthorizationPlan,
        requestedRegistrationMode,
      }),
      options.onTraceUpdate
    );
  const emitTraceFromState = (nextState: OAuthFlowState) =>
    publishOAuthTraceUpdate(
      options.serverName,
      annotateTraceWithAuthorizationPlan({
        trace: buildOAuthTraceFromFlowState({
          source: "interactive_connect",
          serverName: options.serverName,
          serverUrl: options.serverUrl,
          state: nextState,
        }),
        authorizationPlan: traceAuthorizationPlan,
        requestedRegistrationMode,
      }),
      options.onTraceUpdate
    );

  try {
    const provider = createMCPOAuthProvider({
      serverName: options.serverName,
      serverUrl: options.serverUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      hasClientSecret: options.hasClientSecret,
      oauthConfig: {
        resourceUrl: options.resourceUrl,
        registryServerId: options.registryServerId,
        useRegistryOAuthProxy: options.useRegistryOAuthProxy,
      },
    });
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
    traceAuthorizationPlan = authorizationPlan;
    if (
      authorizationPlan.status !== "ready" ||
      !authorizationPlan.registrationStrategy
    ) {
      return {
        success: false,
        error: authorizationPlan.blockers[0] || authorizationPlan.summary,
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
      protocolMode: requestedProtocolMode,
      protocolVersion,
      registrationMode: requestedRegistrationMode,
      registrationStrategy,
    });
    localStorage.setItem(
      `mcp-oauth-config-${options.serverName}`,
      JSON.stringify(oauthConfig)
    );

    // Store custom client id if provided, so it can be retrieved during callback.
    // Client secrets are stored in the encrypted backend server-secret table.
    if (options.clientId) {
      const raw = localStorage.getItem(`mcp-client-${options.serverName}`);
      // Key the write to the CURRENT resolved issuer (discovery has run by the
      // time initiate persists a configured client id). Using the envelope's
      // previous `activeIssuer` would write the configured id into AS A's bucket
      // after a PRM change to AS B, overwriting A and leaving no B bucket
      // (SEP-2352). Before any AS is resolved, store unkeyed — promoted on the
      // next issuer-stamped save.
      const issuer = resolveStoredIssuer(options.serverName, options.serverUrl);
      // Merge into the SAME issuer's existing record (not the active-issuer
      // bucket) so we neither mangle a v2 record nor inherit another AS's fields.
      const { value: existingValue } = readIssuerKeyed<Record<string, unknown>>(
        raw,
        issuer,
        (parsed) =>
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : undefined
      );
      const merged: Record<string, unknown> = {
        ...(existingValue ?? {}),
        client_id: options.clientId,
      };
      delete merged.client_secret;
      localStorage.setItem(
        `mcp-client-${options.serverName}`,
        JSON.stringify(
          issuer ? writeIssuerKeyed(raw, issuer, merged) : merged
        )
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
      // Exact-origin loopback allowance: only when the USER-CONFIGURED server is
      // itself loopback does the SSRF guard permit loopback metadata fetches
      // (a public server can never steer one at the user's own 127.0.0.1).
      allowLoopbackMetadataFetch: isLoopbackOAuthUrl(options.serverUrl),
      hasClientSecret: Boolean(options.clientSecret || options.hasClientSecret),
      sanitizeTrace: SANITIZE_OAUTH_TRACES,
      requestExecutor,
      loadPreregisteredCredentials: async () => {
        const clientInformation = await provider.clientInformation();
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
        const electronAuthorization =
          buildElectronMcpAuthorizationRequest(authorizationUrl);
        const resourceMetadata = getState().resourceMetadata as
          | { resource?: unknown }
          | undefined;
        const oauthResourceUrl = resolveOAuthResourceUrl({
          serverUrl: options.serverUrl,
          authorizationUrl: electronAuthorization.authorizationUrl,
          configuredResourceUrl: options.resourceUrl,
          resourceMetadata,
        });
        // Stamp ?resource= onto the authorization URL so the AS mints a token
        // whose `aud` matches what the MCP server expects. Stored
        // authorization URL is updated to the redirected one so the callback
        // path round-trips the same resource.
        const redirectedAuthorizationUrl = withOAuthResourceParam(
          electronAuthorization.authorizationUrl,
          oauthResourceUrl
        );
        updateState({
          authorizationUrl: redirectedAuthorizationUrl,
          ...(electronAuthorization.state
            ? { state: electronAuthorization.state }
            : {}),
        });
        writeStoredOAuthConfig(options.serverName, {
          resourceUrl: oauthResourceUrl,
        });
        await createHostedOAuthSessionIfNeeded({
          serverName: options.serverName,
          serverUrl: options.serverUrl,
          redirectUrl: provider.redirectUrl,
          state: getState(),
          authorizationUrl: redirectedAuthorizationUrl,
          configuredResourceUrl: oauthResourceUrl,
        });
        await persistOAuthStateArtifacts(provider, getState());
        saveOAuthFlowSession(options.serverName, {
          version: 1,
          protocolVersion,
          registrationStrategy,
          state: cloneFlowState(getState()),
        });
        const preRedirectTrace = emitTraceFromState(getState());
        saveOAuthTraceToSession(options.serverName, preRedirectTrace);
        await provider.redirectToAuthorization(
          new URL(redirectedAuthorizationUrl)
        );
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
        serverConfig: createServerConfig(
          options.serverUrl,
          { access_token: flowResult.state.accessToken },
          protocolVersion
        ),
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
    callbackIss?: string | null;
    onTraceUpdate?: (trace: OAuthTrace) => void;
    authorizationHeader?: string | null;
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
    ? loadOAuthTraceFromSession(serverName)
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
  type TerminalProgressFailureResolver = (failure: {
    message: string;
    oauthTrace?: OAuthTrace;
  }) => void;
  let resolveTerminalProgressFailure: TerminalProgressFailureResolver | null =
    null;

  try {
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }
    if (!context.projectId || !context.serverId) {
      throw new Error("OAuth callback is missing server context");
    }

    startOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: context.sessionId
        ? "Received OAuth callback and restoring server-side callback state."
        : "Received OAuth callback and loading stored callback state.",
    });
    emitTrace(callbackTrace);
    const serverUrl =
      context.serverUrl || localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }
    const storedOAuthConfig = readStoredOAuthConfig(serverName);
    const storedSession = loadOAuthFlowSession(serverName);
    const oauthResourceUrl = resolveOAuthResourceUrl({
      serverUrl,
      authorizationUrl: storedSession?.state.authorizationUrl,
      configuredResourceUrl: storedOAuthConfig.resourceUrl,
      resourceMetadata: storedSession?.state.resourceMetadata as
        | { resource?: unknown }
        | undefined,
    });
    previousTrace = loadOAuthTraceFromSession(serverName) ?? previousTrace;
    clearOAuthTraceSession(serverName);
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: context.sessionId
        ? "Callback state restored from the server session."
        : "Callback state restored.",
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
    // RFC 9207 authorization-response `iss`. The hosted flow redeems the code
    // server-side and the browser has no local session/recorded issuer for it,
    // so the backend performs the exact-match validation; thread the value into
    // the completion request so it CAN (client-side validation isn't possible
    // here). Empty string omitted below.
    const callbackIss =
      typeof options.callbackIss === "string" ? options.callbackIss.trim() : "";
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
              authorizationHeader: options.authorizationHeader,
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
                (
                  resolveTerminalProgressFailure as TerminalProgressFailureResolver
                )({
                  message:
                    progress.lastError ||
                    progress.error ||
                    "OAuth callback failed",
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
          ...(options.authorizationHeader
            ? { Authorization: options.authorizationHeader }
            : {}),
        },
        body: JSON.stringify({
          projectId: context.projectId,
          serverId: context.serverId,
          code: authorizationCode,
          ...(callbackIss ? { iss: callbackIss } : {}),
          oauthResourceUrl,
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
          ...(context.chatboxId ? { chatboxId: context.chatboxId } : {}),
          ...(context.chatboxId &&
          typeof context.accessVersion === "number" &&
          Number.isFinite(context.accessVersion)
            ? { accessVersion: context.accessVersion }
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
            `OAuth callback failed (${response.status})`,
          oauthTrace: result?.oauthTrace,
        };
      }

      if (!result?.success) {
        throw {
          message: result?.error || "OAuth callback failed",
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
    localStorage.removeItem(`mcp-oauth-issued-state-${serverName}`);
    writeStoredOAuthConfig(serverName, {
      resourceUrl: oauthResourceUrl,
    });
    completeOAuthTraceStep(callbackTrace, "token_request", {
      message: "Token exchange succeeded.",
    });
    completeOAuthTraceStep(callbackTrace, "received_access_token", {
      message: "OAuth credential stored for reconnection.",
    });
    completeOAuthTraceStep(callbackTrace, "complete", {
      message: "OAuth callback completed successfully.",
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
      serverConfig: createServerConfig(
        serverUrl,
        undefined,
        storedOAuthConfig.protocolVersion
      ),
      expiresAt: result.expiresAt ?? null,
      oauthTrace: mergedTrace,
      oauthResourceUrl,
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
      message: "OAuth callback failed.",
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
/**
 * 2R-iss — era-agnostic callback security gate. Validates the CSRF `state` and
 * the RFC 9207 authorization-response `iss` from the redirect BEFORE the code
 * is redeemed. Runs on every protocol era: RFC 9207's local-policy row permits
 * validating a present `iss` regardless of version, and validating `state` is
 * always sound. On failure the caller must reject WITHOUT touching the token
 * endpoint and WITHOUT echoing attacker-controlled callback `error*` values.
 */
export function evaluateCallbackSecurity(input: {
  callbackState: string | null | undefined;
  callbackIss: string | null | undefined;
  /** The `state` this flow issued on the authorization request, if any. */
  expectedState: string | undefined;
  /** The exact issuer recorded when the AS metadata was validated. */
  recordedIssuer: string | undefined;
  /** Whether the AS advertised `authorization_response_iss_parameter_supported`. */
  issParameterSupported: boolean | undefined;
}): { ok: true } | { ok: false; error: string } {
  // CSRF: if this flow issued a `state`, the callback MUST return it exactly.
  if (input.expectedState && input.callbackState !== input.expectedState) {
    return {
      ok: false,
      error:
        "OAuth `state` mismatch — the callback did not return the value this flow issued (possible CSRF). Authorization was not completed.",
    };
  }
  const issCheck = validateAuthorizationResponseIssuer({
    recordedIssuer: input.recordedIssuer,
    returnedIss: input.callbackIss ?? undefined,
    issParameterSupported: input.issParameterSupported,
  });
  if (!issCheck.ok) {
    return {
      ok: false,
      error: `OAuth issuer validation failed (RFC 9207): ${issCheck.reason}. Authorization was not completed.`,
    };
  }
  return { ok: true };
}

export async function handleOAuthCallback(
  authorizationCode: string,
  options: {
    onTraceUpdate?: (trace: OAuthTrace) => void;
    // 2R-iss: CSRF `state` and RFC 9207 `iss` captured from the callback URL at
    // the callback boundary and validated here before code redemption.
    callbackState?: string | null;
    callbackIss?: string | null;
  } = {}
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
    serverUrl =
      localStorage.getItem(`mcp-serverUrl-${serverName}`) ?? undefined;
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }

    // Get stored client credentials if any
    const storedClientInfo = readStoredClientInformation(serverName);
    const customClientId = storedClientInfo.client_id;

    const provider = createMCPOAuthProvider({
      serverName,
      serverUrl,
      clientId: customClientId,
      oauthConfig,
    });
    const fetchFn = createOAuthFetchInterceptor(oauthConfig, undefined);
    const requestExecutor = createOAuthRequestExecutor(fetchFn, serverUrl);
    const storedSession = loadOAuthFlowSession(serverName);
    previousTrace = loadOAuthTraceFromSession(serverName);
    clearOAuthTraceSession(serverName);

    if (storedSession) {
      // 2R-iss: validate CSRF `state` + RFC 9207 `iss` before redeeming the
      // code. Reject without touching the token endpoint on any mismatch.
      const security = evaluateCallbackSecurity({
        callbackState: options.callbackState,
        callbackIss: options.callbackIss,
        expectedState: storedSession.state.state,
        recordedIssuer:
          storedSession.state.recordedIssuer ??
          storedSession.state.authorizationServerMetadata?.issuer,
        issParameterSupported:
          storedSession.state.authorizationServerMetadata
            ?.authorization_response_iss_parameter_supported,
      });
      if (!security.ok) {
        clearOAuthFlowSession(serverName);
        localStorage.removeItem("mcp-oauth-pending");
        return { success: false, error: security.error, serverName };
      }
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
      const clientInformation = await provider.clientInformation();
      if (clientInformation?.client_id) {
        updateState({
          clientId: clientInformation.client_id,
          ...(clientInformation.client_secret
            ? { clientSecret: clientInformation.client_secret }
            : {}),
        });
      }
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
        // Exact-origin loopback allowance (see initiate path): opt in only for a
        // user-configured loopback server, never for a public/remote one.
        allowLoopbackMetadataFetch: isLoopbackOAuthUrl(serverUrl),
        sanitizeTrace: SANITIZE_OAUTH_TRACES,
        requestExecutor,
        loadPreregisteredCredentials: async () => {
          const clientInformation = await provider.clientInformation();
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
      const oauthResourceUrl = resolveOAuthResourceUrl({
        serverUrl,
        authorizationUrl: flowResult.state.authorizationUrl,
        configuredResourceUrl: oauthConfig.resourceUrl,
        resourceMetadata: flowResult.state.resourceMetadata as
          | { resource?: unknown }
          | undefined,
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
      writeStoredOAuthConfig(serverName, {
        resourceUrl: oauthResourceUrl,
      });
      clearOAuthFlowSession(serverName);
      localStorage.removeItem(`mcp-verifier-${serverName}`);
      localStorage.removeItem(`mcp-oauth-issued-state-${serverName}`);
      localStorage.removeItem("mcp-oauth-pending");
      return {
        success: true,
        serverConfig: createServerConfig(
          serverUrl,
          { access_token: flowResult.state.accessToken },
          storedSession?.protocolVersion
        ),
        serverName,
        oauthTrace: mergedTrace,
        oauthResourceUrl,
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
      fetchFn,
      oauthConfig.customHeaders
    );
    // 2R-iss / review F6: the flow session that held the issued `state` is gone
    // on this fallback, but every machine issues a state, so an omitted OR
    // mismatched callback state is unverifiable and MUST NOT redeem. Recover the
    // state from its durable key (persisted like the verifier, which this path
    // already depends on surviving). If it can't be recovered, fail closed —
    // there is no value to match, so redemption would skip CSRF entirely.
    const recoveredExpectedState = provider.issuedCallbackState();
    if (!recoveredExpectedState) {
      localStorage.removeItem("mcp-oauth-pending");
      return {
        success: false,
        error:
          "OAuth `state` could not be verified — the issued authorization state was not found, so the callback state cannot be matched (possible CSRF). Please retry the connection.",
        serverName,
      };
    }
    // Validate CSRF `state` (recovered) and RFC 9207 `iss` before redeeming. A
    // missing or mismatched callbackState now fails the state check.
    const fallbackIssuerMetadata = discoveryState.authorizationServerMetadata as
      | {
          issuer?: string;
          authorization_response_iss_parameter_supported?: boolean;
        }
      | undefined;
    const fallbackSecurity = evaluateCallbackSecurity({
      callbackState: options.callbackState,
      callbackIss: options.callbackIss,
      expectedState: recoveredExpectedState,
      recordedIssuer: fallbackIssuerMetadata?.issuer,
      issParameterSupported:
        fallbackIssuerMetadata?.authorization_response_iss_parameter_supported,
    });
    if (!fallbackSecurity.ok) {
      localStorage.removeItem("mcp-oauth-pending");
      return { success: false, error: fallbackSecurity.error, serverName };
    }
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Callback state restored.",
      details: {
        clientId: clientInformation.client_id,
      },
    });
    emitTrace(callbackTrace);
    // Resource URL comes from the server's discovery document — treat it as
    // untrusted input; resolveOAuthResourceUrl rejects invalid/cross-origin
    // values. Resolving ONCE here keeps the token-exchange wire value, the
    // stored resourceUrl, and the original authorization request identical.
    const oauthResourceUrl = resolveOAuthResourceUrl({
      serverUrl,
      configuredResourceUrl: oauthConfig.resourceUrl,
      resourceMetadata: discoveryState.resourceMetadata as
        | { resource?: unknown }
        | undefined,
    });
    const resource = oauthResourceUrl;
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
      message: "OAuth tokens were stored securely.",
    });
    completeOAuthTraceStep(callbackTrace, "complete", {
      message: "OAuth callback completed successfully.",
    });

    // Clean up pending state
    localStorage.removeItem("mcp-oauth-pending");
    localStorage.removeItem(`mcp-verifier-${serverName}`);
    localStorage.removeItem(`mcp-oauth-issued-state-${serverName}`);
    writeStoredOAuthConfig(serverName, {
      resourceUrl: oauthResourceUrl,
    });
    const mergedTrace = mergeOAuthTraces(previousTrace, callbackTrace);
    publishOAuthTraceUpdate(serverName, mergedTrace, options.onTraceUpdate);

    const serverConfig = createServerConfig(
      serverUrl,
      tokens,
      oauthConfig.protocolVersion
    );
    return {
      success: true,
      serverConfig,
      serverName, // Return server name so caller doesn't need to look it up
      oauthTrace: mergedTrace,
      oauthResourceUrl,
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
  if (HOSTED_MODE) {
    return { tokens: undefined, isInvalid: false };
  }
  const raw = localStorage.getItem(`mcp-tokens-${serverName}`);
  // TODO: Maybe we should move clientID away from the token info? Not sure if clientID is bonded to token
  if (!raw) return { tokens: undefined, isInvalid: false };

  // A present-but-unparseable record is corrupt (isInvalid), distinct from an
  // absent one — detect that up front so the issuer gating below doesn't
  // silently reclassify malformed data as "no tokens".
  try {
    JSON.parse(raw);
  } catch {
    return { tokens: undefined, isInvalid: true };
  }

  // SEP-2352: gate the record by the exact resolved issuer so a v2-keyed AS-A
  // token bucket is never surfaced after PRM resolves to AS B. Legacy unkeyed
  // records stay readable as UNBOUND compat (parity with the client-id read).
  const issuer = resolveStoredIssuer(serverName);
  const { value: tokensJson } = readIssuerKeyed<any>(
    raw,
    issuer,
    parseLegacyStoredTokens
  );
  if (!tokensJson) {
    // A v2 envelope with no bucket for the resolved issuer: not corrupt, just
    // not this AS's tokens — treat as absent so the flow re-authorizes.
    return { tokens: undefined, isInvalid: false };
  }

  const clientJson = readStoredClientInformation(serverName);
  return {
    tokens: {
      ...tokensJson,
      client_id: clientJson.client_id || tokensJson.client_id,
    },
    isInvalid: false,
  };
}

export function getStoredTokens(serverName: string): any {
  return getStoredTokensState(serverName).tokens;
}

/**
 * Checks if OAuth is configured for a server by looking at multiple sources
 */
export function hasOAuthConfig(serverName: string): boolean {
  if (HOSTED_MODE) {
    return false;
  }
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
    const storedClientInfo = readStoredClientInformation(serverName);
    const customClientId = storedClientInfo.client_id;

    // Get server URL
    const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      emitTrace();
      return {
        success: false,
        error: "Server URL not found for token refresh",
      };
    }

    const provider = createMCPOAuthProvider({
      serverName,
      serverUrl,
      clientId: customClientId,
      oauthConfig,
    });
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
      fetchFn,
      oauthConfig.customHeaders
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
    // RFC 8707: the refresh request must carry the same resource as the
    // original grant. Replay the stored value from the initial exchange when
    // present; otherwise resolve through the same shared policy the initial
    // flow used (selectResourceURL would re-derive — and strictly reject —
    // values the initial flow legitimately accepted).
    const resource =
      oauthConfig.resourceUrl?.trim() ||
      resolveOAuthResourceUrl({
        serverUrl,
        resourceMetadata: discoveryState.resourceMetadata as
          | { resource?: unknown }
          | undefined,
      });
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
      message: "Refreshed OAuth tokens were stored securely.",
    });
    completeOAuthTraceStep(trace, "complete", {
      message: "OAuth token refresh completed successfully.",
    });
    emitTrace();
    const serverConfig = createServerConfig(
      serverUrl,
      tokens,
      oauthConfig.protocolVersion
    );
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
  localStorage.removeItem(`mcp-oauth-issued-state-${serverName}`);
  localStorage.removeItem(`mcp-serverUrl-${serverName}`);
  localStorage.removeItem(`mcp-oauth-config-${serverName}`);
  oauthBindingStorage.clear(serverName);
  clearStoredDiscoveryState(serverName);
  clearOAuthFlowSession(serverName);
  clearOAuthTrace(serverName);
  clearOAuthTraceSession(serverName);
}

/**
 * Creates MCP server configuration with OAuth tokens
 */
export function createServerConfig(
  serverUrl: string,
  tokens?: { access_token?: string | null },
  protocolVersion?: OAuthProtocolVersion
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
    // Pin the sessionless 2026 wire era so the post-OAuth reconnect/test
    // probes via the stateless path, not the default 2025 initialize. Only
    // 2026 is coupled and non-default; older OAuth versions map to the legacy
    // default (unset), so they stay exactly as before.
    ...(protocolVersion === "2026-07-28"
      ? { mcpProtocolVersion: "2026-07-28" as const }
      : {}),
  };
}
