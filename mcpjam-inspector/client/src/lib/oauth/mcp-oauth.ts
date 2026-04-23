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
  getStepIndex,
  getStepInfo,
  EMPTY_OAUTH_FLOW_STATE,
  runOAuthStateMachine,
  selectResourceURL,
} from "@mcpjam/sdk/browser";
import type {
  HttpHistoryEntry,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthFlowState,
  OAuthProtocolVersion,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "@mcpjam/sdk/browser";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import { generateRandomString } from "./pkce";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { captureServerDetailModalOAuthResume } from "@/lib/server-detail-modal-resume";
import type { HostedOAuthCallbackContext } from "@/lib/hosted-oauth-callback";
import { getRedirectUri } from "./constants";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import {
  appendOAuthTraceHttpHistory,
  clearOAuthTrace,
  completeOAuthTraceStep,
  createOAuthTrace,
  failOAuthTraceStep,
  loadOAuthTrace,
  mergeOAuthTraces,
  saveOAuthTrace,
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
  protocolVersion?: OAuthProtocolVersion;
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

const DEFAULT_OAUTH_PROTOCOL_VERSION: OAuthProtocolVersion = "2025-11-25";
const DEFAULT_OAUTH_REGISTRATION_STRATEGY: OAuthRegistrationStrategy = "dcr";

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
  "authorization",
]);

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

  const looksStructured =
    trimmed.includes("=") ||
    trimmed.includes("&") ||
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")));
  if (looksStructured) {
    const parsed = parseOAuthRequestFields(trimmed);
    if (parsed) {
      return sanitizeOAuthTraceValue(parsed);
    }
  }

  return trimmed
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|code_verifier)\b(\s*[:=]\s*)([^\s&,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]");
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
      if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
        return [key, redactSensitiveValue(entryValue)];
      }
      return [key, sanitizeOAuthTraceValue(entryValue)];
    }),
  );
}

function sanitizeOAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
        return [key, redactSensitiveValue(value)];
      }
      return [key, value];
    }),
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
      url: input.url,
      headers: sanitizeOAuthHeaders(input.headers ?? {}),
      body: sanitizeOAuthTraceValue(input.body),
    },
  };
}

async function readResponseBodyForTrace(response: Response): Promise<unknown> {
  try {
    return sanitizeOAuthTraceValue(await response.clone().json());
  } catch {
    try {
      const text = await response.clone().text();
      return text ? sanitizeOAuthTraceValue(text) : null;
    } catch {
      return null;
    }
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

function normalizeResponseHeaders(
  headers: Headers,
): Record<string, string> {
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
  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    try {
      return sanitizeOAuthTraceValue(JSON.parse(text));
    } catch {
      return sanitizeOAuthTraceValue(text);
    }
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return sanitizeOAuthTraceValue(JSON.parse(text));
    } catch {
      return sanitizeOAuthTraceValue(text);
    }
  }

  return sanitizeOAuthTraceValue(text);
}

function serializeOAuthRequestBody(
  body: HttpHistoryEntry["request"]["body"],
  headers: Record<string, string>,
): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string" || body instanceof URLSearchParams) {
    return body;
  }

  const contentType =
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(
      Object.entries(body as Record<string, string>).map(([key, value]) => [
        key,
        String(value),
      ]),
    ).toString();
  }

  return JSON.stringify(body);
}

function saveOAuthFlowSession(
  serverName: string,
  session: StoredOAuthFlowSession,
): void {
  localStorage.setItem(
    getFlowStateStorageKey(serverName),
    JSON.stringify(session),
  );
}

function loadOAuthFlowSession(
  serverName: string,
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

    return parsed;
  } catch {
    return undefined;
  }
}

function clearOAuthFlowSession(serverName: string): void {
  localStorage.removeItem(getFlowStateStorageKey(serverName));
}

function sanitizeHttpHistoryEntry(entry: HttpHistoryEntry): HttpHistoryEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
      headers: sanitizeOAuthHeaders(entry.request.headers),
      body: sanitizeOAuthTraceValue(entry.request.body),
    },
    ...(entry.response
      ? {
          response: {
            ...entry.response,
            headers: sanitizeOAuthHeaders(entry.response.headers),
            body: sanitizeOAuthTraceValue(entry.response.body),
          },
        }
      : {}),
    ...(entry.error
      ? {
          error: {
            ...entry.error,
            details: sanitizeOAuthTraceValue(entry.error.details),
          },
        }
      : {}),
  };
}

function resolveOAuthProtocolVersion(
  options: Pick<MCPOAuthOptions, "protocolVersion">,
): OAuthProtocolVersion {
  return options.protocolVersion ?? DEFAULT_OAUTH_PROTOCOL_VERSION;
}

function resolveOAuthRegistrationStrategy(
  options: Pick<
    MCPOAuthOptions,
    "registrationStrategy" | "clientId" | "clientSecret" | "useRegistryOAuthProxy"
  >,
  provider: MCPOAuthProvider,
): OAuthRegistrationStrategy {
  if (options.registrationStrategy) {
    return options.registrationStrategy;
  }

  const storedClient = provider.clientInformation();
  if (
    options.useRegistryOAuthProxy ||
    options.clientId ||
    options.clientSecret ||
    storedClient?.client_id
  ) {
    return "preregistered";
  }

  return DEFAULT_OAUTH_REGISTRATION_STRATEGY;
}

function createOAuthRequestExecutor(fetchFn: typeof fetch) {
  return async (request: HttpHistoryEntry["request"]) => {
    const response = await fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: serializeOAuthRequestBody(request.body, request.headers),
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: normalizeResponseHeaders(response.headers),
      body: await parseOAuthResponseBody(response),
      ok: response.ok,
    };
  };
}

function saveDiscoveryStateFromFlowState(
  provider: MCPOAuthProvider,
  state: OAuthFlowState,
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
  state: OAuthFlowState,
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
  const trace = createOAuthTrace({
    source: input.source,
    serverName: input.serverName,
    serverUrl: input.serverUrl,
  });
  const state = input.state;
  const currentStepIndex = getStepIndex(state.currentStep);
  trace.currentStep = state.currentStep;
  trace.error = state.error;
  trace.httpHistory = (state.httpHistory ?? []).map((entry) =>
    sanitizeHttpHistoryEntry(entry),
  );

  const entries = new Map<
    string,
    {
      step: HttpHistoryEntry["step"];
      startedAt: number;
      completedAt?: number;
      message?: string;
      details?: Record<string, unknown>;
      error?: string;
    }
  >();

  const ensureStep = (step: HttpHistoryEntry["step"], timestamp: number) => {
    const existing = entries.get(step);
    if (existing) {
      existing.startedAt = Math.min(existing.startedAt, timestamp);
      existing.completedAt = Math.max(
        existing.completedAt ?? timestamp,
        timestamp,
      );
      return existing;
    }

    const created = {
      step,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    entries.set(step, created);
    return created;
  };

  for (const entry of state.httpHistory ?? []) {
    const record = ensureStep(entry.step, entry.timestamp);
    if (!record.details) {
      record.details = {
        request: sanitizeOAuthTraceValue(entry.request),
        ...(entry.response
          ? { response: sanitizeOAuthTraceValue(entry.response) }
          : {}),
      };
    }
    if (entry.error?.message) {
      record.error = entry.error.message;
    }
  }

  for (const log of state.infoLogs ?? []) {
    const record = ensureStep(log.step, log.timestamp);
    record.message = log.label;
    if (
      log.data &&
      typeof sanitizeOAuthTraceValue(log.data) === "object" &&
      sanitizeOAuthTraceValue(log.data) !== null &&
      !Array.isArray(sanitizeOAuthTraceValue(log.data))
    ) {
      record.details = sanitizeOAuthTraceValue(log.data) as Record<string, unknown>;
    }
    if (log.error?.message) {
      record.error = log.error.message;
    }
  }

  const baseTimestamp = Math.max(
    Date.now(),
    ...(state.httpHistory ?? []).map((entry) => entry.timestamp),
    ...(state.infoLogs ?? []).map((entry) => entry.timestamp),
  );
  let syntheticTimestamp = baseTimestamp;
  const inferStep = (
    step: HttpHistoryEntry["step"],
    condition: boolean,
    details?: Record<string, unknown>,
  ) => {
    if (!condition || entries.has(step)) {
      return;
    }

    syntheticTimestamp += 1;
    entries.set(step, {
      step,
      startedAt: syntheticTimestamp,
      completedAt: syntheticTimestamp,
      details,
    });
  };

  inferStep("request_client_registration", Boolean(state.clientId), {
    clientId: state.clientId,
  });
  inferStep("received_client_credentials", Boolean(state.clientId), {
    clientId: state.clientId,
  });
  inferStep("generate_pkce_parameters", Boolean(state.codeVerifier), {
    codeVerifier: redactSensitiveValue(state.codeVerifier),
  });
  inferStep("authorization_request", Boolean(state.authorizationUrl), {
    authorizationUrl: state.authorizationUrl,
  });
  inferStep(
    "received_authorization_code",
    Boolean(state.authorizationCode),
    state.authorizationCode
      ? { code: redactSensitiveValue(state.authorizationCode) }
      : undefined,
  );
  inferStep("received_access_token", Boolean(state.accessToken), {
    tokenType: state.tokenType,
    expiresIn: state.expiresIn,
  });
  inferStep("complete", state.currentStep === "complete");

  if (state.error && !entries.has(state.currentStep)) {
    syntheticTimestamp += 1;
    entries.set(state.currentStep, {
      step: state.currentStep,
      startedAt: syntheticTimestamp,
      completedAt: syntheticTimestamp,
      error: state.error,
    });
  }

  trace.steps = Array.from(entries.values())
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        getStepIndex(left.step) - getStepIndex(right.step),
    )
    .map((entry) => {
      const stepIndex = getStepIndex(entry.step);
      const status =
        entry.error || (entry.step === state.currentStep && state.error)
          ? "error"
          : stepIndex < currentStepIndex ||
              state.currentStep === "complete" ||
              (entry.step === state.currentStep &&
                ((entry.step === "authorization_request" &&
                  Boolean(state.authorizationUrl)) ||
                  (entry.step === "received_authorization_code" &&
                    Boolean(state.authorizationCode)) ||
                  (entry.step === "received_access_token" &&
                    Boolean(state.accessToken)) ||
                  (entry.step === "complete" &&
                    state.currentStep === "complete")))
            ? "success"
            : entry.step === state.currentStep
              ? "pending"
              : "success";

      return {
        step: entry.step,
        title: getStepInfo(entry.step).title,
        status,
        message: entry.message ?? getStepInfo(entry.step).summary,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.details ? { details: entry.details } : {}),
        startedAt: entry.startedAt,
        completedAt: status === "pending" ? undefined : entry.completedAt,
      };
    });

  return trace;
}

export function readStoredOAuthConfig(
  serverName: string | null,
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
      protocolVersion:
        parsed?.protocolVersion === "2025-03-26" ||
        parsed?.protocolVersion === "2025-06-18" ||
        parsed?.protocolVersion === "2025-11-25"
          ? parsed.protocolVersion
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
          ([, value]) => typeof value === "string",
        ) as Array<[string, string]>,
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
    | "protocolVersion"
    | "registrationStrategy"
  >,
): StoredOAuthConfig {
  const config: StoredOAuthConfig = {
    registryServerId: options.registryServerId,
    useRegistryOAuthProxy: options.useRegistryOAuthProxy === true,
    protocolVersion: options.protocolVersion,
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
  body: unknown,
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
  body: unknown,
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
  config: OAuthRoutingRequestConfig,
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
  fields: OAuthRequestFields,
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
): Promise<OAuthDiscoveryState> {
  const cachedState = await provider.discoveryState();
  if (cachedState?.authorizationServerUrl) {
    const authorizationServerMetadata =
      cachedState.authorizationServerMetadata ??
      (await discoverAuthorizationServerMetadata(
        cachedState.authorizationServerUrl,
        { fetchFn },
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

/**
 * Custom fetch interceptor that proxies OAuth requests through our server to avoid CORS.
 * When a registryServerId is provided, token exchange/refresh is routed through
 * the Convex HTTP registry OAuth endpoints which inject server-side secrets.
 */
function createOAuthFetchInterceptor(
  routingConfig: OAuthRoutingConfig = {},
  trace?: OAuthTrace,
): typeof fetch {
  return async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
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
              registryTokenRequest.body,
            ),
          ),
        });
        entry.response = {
          status: response.status,
          statusText: response.statusText,
          headers: sanitizeOAuthHeaders(
            Object.fromEntries(response.headers.entries()),
          ),
          body: await readResponseBodyForTrace(response),
        };
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
        entry.response = {
          status: response.status,
          statusText: response.statusText,
          headers: sanitizeOAuthHeaders(
            Object.fromEntries(response.headers.entries()),
          ),
          body: await readResponseBodyForTrace(response),
        };
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
        entry.response = {
          status: response.status,
          statusText: response.statusText,
          headers: sanitizeOAuthHeaders(
            Object.fromEntries(response.headers.entries()),
          ),
          body: await readResponseBodyForTrace(response),
        };
        entry.duration = Date.now() - entry.timestamp;
        return response;
      }

      const data = await response.json();
      entry.response = {
        status: data.status,
        statusText: data.statusText,
        headers: sanitizeOAuthHeaders(data.headers ?? {}),
        body: sanitizeOAuthTraceValue(data.body),
      };
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
      console.error("OAuth proxy failed, falling back to direct fetch:", error);
      return await originalFetch(input, init);
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
  protocolVersion?: OAuthProtocolVersion;
  registrationStrategy?: OAuthRegistrationStrategy;
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
    customClientSecret?: string,
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
      JSON.stringify(clientInformation),
    );
  }

  tokens() {
    const stored = localStorage.getItem(`mcp-tokens-${this.serverName}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveTokens(tokens: any) {
    localStorage.setItem(
      `mcp-tokens-${this.serverName}`,
      JSON.stringify(tokens),
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
      getDiscoveryStorageKey(this.serverName),
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
      JSON.stringify(payload),
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
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
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
  serverName: string,
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
  options: MCPOAuthOptions,
): Promise<OAuthResult> {
  let state = cloneEmptyFlowState();
  const updateState = (updates: Partial<OAuthFlowState>) => {
    state = { ...state, ...updates };
  };
  const getState = () => state;

  try {
    const provider = new MCPOAuthProvider(
      options.serverName,
      options.serverUrl,
      options.clientId,
      options.clientSecret,
    );
    const protocolVersion = resolveOAuthProtocolVersion(options);
    const registrationStrategy = resolveOAuthRegistrationStrategy(
      options,
      provider,
    );
    const fetchFn = createOAuthFetchInterceptor(
      {
        registryServerId: options.registryServerId,
        useRegistryOAuthProxy: options.useRegistryOAuthProxy,
      },
      undefined,
    );
    const requestExecutor = createOAuthRequestExecutor(fetchFn);

    // Store server URL for callback recovery
    localStorage.setItem(
      `mcp-serverUrl-${options.serverName}`,
      options.serverUrl,
    );
    localStorage.setItem("mcp-oauth-pending", options.serverName);

    // Store OAuth configuration (scopes, registryServerId) for recovery if connection fails
    const oauthConfig = buildStoredOAuthConfig(options);
    localStorage.setItem(
      `mcp-oauth-config-${options.serverName}`,
      JSON.stringify(oauthConfig),
    );

    // Store custom client credentials if provided, so they can be retrieved during callback
    if (options.clientId || options.clientSecret) {
      const existingClientInfo = localStorage.getItem(
        `mcp-client-${options.serverName}`,
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
        JSON.stringify(updatedClientInfo),
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
      onAuthorizationRequest: async ({ authorizationUrl }) => {
        await persistOAuthStateArtifacts(provider, getState());
        saveOAuthFlowSession(options.serverName, {
          version: 1,
          protocolVersion,
          registrationStrategy,
          state: cloneFlowState(getState()),
        });
        const redirectTrace = buildOAuthTraceFromFlowState({
          source: "interactive_connect",
          serverName: options.serverName,
          serverUrl: options.serverUrl,
          state: getState(),
        });
        saveOAuthTrace(options.serverName, redirectTrace);
        await provider.redirectToAuthorization(new URL(authorizationUrl));
        return { type: "redirect" };
      },
    });

    const trace = buildOAuthTraceFromFlowState({
      source: "interactive_connect",
      serverName: options.serverName,
      serverUrl: options.serverUrl,
      state: flowResult.state,
    });
    saveOAuthTrace(options.serverName, trace);

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
    saveOAuthTrace(options.serverName, trace);

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
): Promise<OAuthResult & { serverName?: string; expiresAt?: number | null }> {
  const serverName = context.serverName || localStorage.getItem("mcp-oauth-pending");
  const callbackTrace = createOAuthTrace({
    source: "hosted_callback",
    serverName: serverName ?? undefined,
  });

  try {
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }
    if (!context.workspaceId || !context.serverId) {
      throw new Error("Hosted OAuth callback is missing server context");
    }

    startOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Received hosted OAuth callback and loading stored callback state.",
    });
    const serverUrl =
      context.serverUrl || localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }

    const codeVerifier = localStorage.getItem(`mcp-verifier-${serverName}`);
    if (!codeVerifier) {
      throw new Error("Code verifier not found");
    }

    const clientInformation = readStoredClientInformation(serverName);
    if (!clientInformation.client_id) {
      throw new Error("OAuth client ID not found");
    }
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Hosted callback state restored.",
      details: {
        serverUrl,
        clientId: clientInformation.client_id,
      },
    });

    const convexSiteUrl = getConvexSiteUrl();
    const response = await authFetch(`${convexSiteUrl}/web/oauth/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: context.workspaceId,
        serverId: context.serverId,
        serverUrl,
        code: authorizationCode,
        codeVerifier,
        redirectUri: getRedirectUri(),
        clientInformation: {
          clientId: clientInformation.client_id,
          ...(clientInformation.client_secret
            ? { clientSecret: clientInformation.client_secret }
            : {}),
        },
        ...(context.accessScope ? { accessScope: context.accessScope } : {}),
        ...(context.shareToken ? { shareToken: context.shareToken } : {}),
        ...(context.chatboxToken ? { chatboxToken: context.chatboxToken } : {}),
      }),
    });

    const result =
      (await response
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
    const mergedTrace = mergeOAuthTraces(
      loadOAuthTrace(serverName),
      result.oauthTrace
        ? mergeOAuthTraces(callbackTrace, result.oauthTrace)
        : callbackTrace,
    );
    saveOAuthTrace(serverName, mergedTrace);
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
          ? ((error as { message: string }).message)
          : String(error);
    failOAuthTraceStep(callbackTrace, callbackTrace.currentStep, message, {
      message: "Hosted OAuth callback failed.",
    });
    const backendTrace =
      typeof error === "object" && error !== null && "oauthTrace" in error
        ? ((error as { oauthTrace?: OAuthTrace }).oauthTrace ?? undefined)
        : undefined;
    const mergedTrace =
      serverName != null
        ? mergeOAuthTraces(
            loadOAuthTrace(serverName),
            backendTrace
              ? mergeOAuthTraces(callbackTrace, backendTrace)
              : callbackTrace,
          )
        : backendTrace
          ? mergeOAuthTraces(callbackTrace, backendTrace)
          : callbackTrace;
    if (serverName) {
      saveOAuthTrace(serverName, mergedTrace);
      clearOAuthFlowSession(serverName);
    }
    return {
      success: false,
      error: formatOAuthCallbackError(message),
      oauthTrace: mergedTrace,
    };
  }
}

/**
 * Handles OAuth callback and completes the flow
 */
export async function handleOAuthCallback(
  authorizationCode: string,
): Promise<OAuthResult & { serverName?: string }> {
  // Get pending server name from localStorage (needed before creating interceptor)
  const serverName = localStorage.getItem("mcp-oauth-pending");

  // Read registryServerId from stored OAuth config if present
  const oauthConfig = readStoredOAuthConfig(serverName);

  try {
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }

    // Get server URL
    const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
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
      customClientSecret,
    );
    const fetchFn = createOAuthFetchInterceptor(oauthConfig, undefined);
    const requestExecutor = createOAuthRequestExecutor(fetchFn);
    const storedSession = loadOAuthFlowSession(serverName);

    if (storedSession) {
      let state = cloneFlowState(storedSession.state);
      const updateState = (updates: Partial<OAuthFlowState>) => {
        state = { ...state, ...updates };
      };
      const getState = () => state;

      updateState({
        currentStep: "received_authorization_code",
        authorizationCode,
        error: undefined,
      });

      const flowResult = await runOAuthStateMachine({
        protocolVersion: storedSession.protocolVersion,
        registrationStrategy: storedSession.registrationStrategy,
        state,
        getState,
        updateState,
        serverUrl,
        serverName,
        redirectUrl: provider.redirectUrl,
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
            storedSession.protocolVersion,
          ),
          ...provider.clientMetadata,
        },
        clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
        customScopes: oauthConfig.scopes?.join(" "),
        customHeaders: oauthConfig.customHeaders,
        authMode: "interactive",
      });

      const callbackTrace = buildOAuthTraceFromFlowState({
        source: "callback",
        serverName,
        serverUrl,
        state: flowResult.state,
      });
      const mergedTrace = mergeOAuthTraces(
        loadOAuthTrace(serverName),
        callbackTrace,
      );
      saveOAuthTrace(serverName, mergedTrace);

      if (flowResult.error || !flowResult.completed || !flowResult.state.accessToken) {
        return {
          success: false,
          error: formatOAuthCallbackError(
            flowResult.error?.message || flowResult.state.error,
          ),
          oauthTrace: mergedTrace,
        };
      }

      await persistOAuthStateArtifacts(provider, flowResult.state);
      clearOAuthFlowSession(serverName);
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
    startOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Received OAuth callback and loading stored state.",
      details: {
        serverUrl,
      },
    });
    const clientInformation = await provider.clientInformation();
    if (!clientInformation?.client_id) {
      throw new Error("OAuth client ID not found");
    }
    const discoveryState = await loadCallbackDiscoveryState(
      provider,
      serverUrl,
      fetchFn,
    );
    completeOAuthTraceStep(callbackTrace, "received_authorization_code", {
      message: "Callback state restored.",
      details: {
        clientId: clientInformation.client_id,
      },
    });
    const resource = await selectResourceURL(
      serverUrl,
      provider,
      discoveryState.resourceMetadata,
    );
    startOAuthTraceStep(callbackTrace, "token_request", {
      message: "Exchanging authorization code for OAuth tokens.",
    });
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
      },
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
    const mergedTrace = mergeOAuthTraces(
      loadOAuthTrace(serverName),
      callbackTrace,
    );
    saveOAuthTrace(serverName, mergedTrace);

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
        serverName != null
          ? (localStorage.getItem(`mcp-serverUrl-${serverName}`) ?? "")
          : "",
      state: {
        ...cloneEmptyFlowState(),
        currentStep: "received_authorization_code",
        error: formatOAuthCallbackError(error),
      },
    });
    const mergedTrace = serverName
      ? mergeOAuthTraces(loadOAuthTrace(serverName), callbackTrace)
      : callbackTrace;
    if (serverName) {
      saveOAuthTrace(serverName, mergedTrace);
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
    `mcp-oauth-config-${serverName}`,
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
  timeoutMs: number = 5000,
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
): Promise<OAuthResult> {
  const trace = createOAuthTrace({
    source: "refresh",
    serverName,
  });
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
      return {
        success: false,
        error: "Server URL not found for token refresh",
      };
    }

    const provider = new MCPOAuthProvider(
      serverName,
      serverUrl,
      customClientId,
      customClientSecret,
    );
    const existingTokens = provider.tokens();

    if (!existingTokens?.refresh_token) {
      return {
        success: false,
        error: "No refresh token available",
        oauthTrace: trace,
      };
    }

    startOAuthTraceStep(trace, "request_resource_metadata", {
      message: "Refreshing OAuth tokens and rediscovering server metadata.",
    });
    const discoveryState = await loadCallbackDiscoveryState(
      provider,
      serverUrl,
      fetchFn,
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
    const resource = await selectResourceURL(
      serverUrl,
      provider,
      discoveryState.resourceMetadata,
    );
    startOAuthTraceStep(trace, "token_request", {
      message: "Refreshing tokens with the stored refresh token.",
    });
    const tokens = await fetchToken(provider, discoveryState.authorizationServerUrl, {
      metadata: discoveryState.authorizationServerMetadata,
      ...(resource ? { resource } : {}),
      fetchFn,
    });
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
    saveOAuthTrace(serverName, trace);
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
    saveOAuthTrace(serverName, trace);

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
  tokens?: { access_token?: string | null },
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
