import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import { useConvex } from "convex/react";
import { toast } from "@/lib/toast";
import type {
  HttpServerConfig,
  MCPServerConfig,
  NormalizedError,
} from "@mcpjam/sdk/browser";
import {
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  readXaaEnterprisePolicy,
} from "@mcpjam/sdk/browser";
import { normalizeRegistrationMode } from "@/shared/xaa.js";
import type {
  AppAction,
  AppState,
  ServerWithName,
  Project,
} from "@/state/app-types";
import {
  testConnection,
  deleteServer,
  listServers,
  reconnectServer,
  getInitializationInfo,
} from "@/state/mcp-api";
import {
  ensureAuthorizedForReconnect,
  type OAuthResult,
} from "@/state/oauth-orchestrator";
import {
  resolveOAuthProtocolSelection,
  type ServerFormData,
} from "@/shared/types.js";
import { toMCPConfig } from "@/state/server-helpers";
import {
  completeHostedOAuthCallback,
  handleOAuthCallback,
  clearOAuthData,
  initiateOAuth,
  isElectronMcpCallbackState,
  readStoredOAuthConfig,
  OAUTH_PENDING_STORAGE_KEY,
} from "@/lib/oauth/mcp-oauth";
import {
  buildOAuthRequest,
  selectStoredResourceUrl,
  type BuiltOAuthRequest,
} from "@/lib/oauth/oauth-request";
import {
  importHostedOAuthTokens,
  normalizeImportHostedOAuthTokens,
} from "@/lib/apis/hosted-oauth-import-tokens-api";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";
import {
  autoOAuthEscalation,
  confirmAutoOAuthEscalation,
  type AutoEscalationIdentity,
} from "@/lib/oauth/auto-oauth-escalation";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  resolveHostedOAuthReturnPath,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import {
  markPendingChatScopeStepUpCancelled,
  markPendingChatScopeStepUpReady,
} from "@/lib/scope-step-up-pending";
import {
  cancelPendingDirectScopeStepUpReplay,
  markPendingDirectScopeStepUpReplayReady,
} from "@/lib/scope-step-up-replay";
import { HOSTED_MODE } from "@/lib/config";
import { isPrivateNetworkUrl } from "@/shared/private-address";
import { resolveXaaIdentitySaveFields } from "@/lib/xaa/identity";
import { validateServerFormData } from "@/lib/server-form-validation";
import {
  injectHostedServerMapping,
  tryGetHostedServerDisplayName,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import { authFetch } from "@/lib/session-token";
import {
  captureCurrentReturnPath,
  isDebugOAuthCallbackPath,
  navigateApp,
  normalizeReturnTargetPath,
  routePaths,
} from "@/lib/app-navigation";
import { useProjectClientConfigSyncPending } from "./use-project-client-config-sync-pending";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useServerMutations, type RemoteServer } from "./useProjects";
import { writeCliSignInReturnPath } from "@/lib/cli-signin-return-path";
import {
  CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE,
  PROJECT_NOT_PROVISIONED_ERROR_MESSAGE,
  getEffectiveProjectConnectionDefaults,
  mergeProjectConnectionHeaders,
} from "@/lib/client-config";
import { resolveEffectiveClientCapabilities } from "@/lib/effective-client";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { readOnboardingState } from "@/lib/onboarding-state";
import {
  type HostConfigDtoV2,
  type McpProtocolVersion,
} from "@/lib/client-config-v2";
import { resolveServerConnectionSettings } from "@/lib/client-connection-resolve";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { standardEventProps } from "@/lib/PosthogUtils";
import { track } from "@/lib/analytics";
import { isProtocolVersionPinFailure } from "@/lib/protocol-version-pin";
import { toastServerConnectionFailure } from "@/lib/server-error-toast";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import type { ConnectionDefaults } from "@/shared/connection-defaults";

export interface HostedServerWriteTarget {
  projectId: string;
  serverId: string;
}

/** Skip noisy connect toast while first-run App Builder onboarding is in progress. */
function shouldSuppressExcalidrawConnectToastForOnboarding(
  serverName: string
): boolean {
  if (serverName !== EXCALIDRAW_SERVER_NAME) return false;
  const status = readOnboardingState()?.status;
  return status === "seen";
}

function extractRequestHeaders(
  requestInit: RequestInit | undefined
): Record<string, string> | undefined {
  const headers = requestInit?.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string"
      )
    );
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
}

function hasBearerAuthorizationHeader(
  headers?: Record<string, string>
): boolean {
  if (!headers) {
    return false;
  }

  return Object.entries(headers).some(
    ([key, value]) =>
      key.trim().toLowerCase() === "authorization" &&
      value.trim().toLowerCase().startsWith("bearer ")
  );
}

function getRedactedConfigFlag(
  config: unknown,
  flag: "hasBearerToken"
): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    (config as Record<string, unknown>)[flag] === true
  );
}

function getServerBearerTokenState(
  server: ServerWithName | undefined
): boolean | undefined {
  if (!server) {
    return undefined;
  }

  const config = server.config as {
    requestInit?: RequestInit;
    hasBearerToken?: true;
  };
  if (
    getRedactedConfigFlag(config, "hasBearerToken") ||
    hasBearerAuthorizationHeader(extractRequestHeaders(config.requestInit))
  ) {
    return true;
  }

  return server.hasBearerToken;
}

function omitAuthorizationHeader(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        key.toLowerCase() !== "authorization" && typeof value === "string"
    )
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeOAuthCallbackServerConfig(
  existingConfig: MCPServerConfig | undefined,
  callbackConfig: HttpServerConfig
): HttpServerConfig {
  const existingHttpConfig =
    existingConfig && "url" in existingConfig ? existingConfig : undefined;
  const mergedHeaders = {
    ...(omitAuthorizationHeader(
      extractRequestHeaders(existingHttpConfig?.requestInit)
    ) ?? {}),
    ...(omitAuthorizationHeader(
      extractRequestHeaders(callbackConfig.requestInit)
    ) ?? {}),
  };
  const nextRequestInit =
    existingHttpConfig?.requestInit || callbackConfig.requestInit
      ? {
          ...(existingHttpConfig?.requestInit ?? {}),
          ...(callbackConfig.requestInit ?? {}),
        }
      : undefined;
  if (nextRequestInit) {
    if (Object.keys(mergedHeaders).length > 0) {
      nextRequestInit.headers = mergedHeaders;
    } else {
      delete nextRequestInit.headers;
    }
  }

  return {
    ...(existingHttpConfig ?? {}),
    ...callbackConfig,
    ...(nextRequestInit ? { requestInit: nextRequestInit } : {}),
    timeout: callbackConfig.timeout ?? existingHttpConfig?.timeout,
    capabilities:
      callbackConfig.capabilities ?? existingHttpConfig?.capabilities,
    clientCapabilities:
      callbackConfig.clientCapabilities ??
      existingHttpConfig?.clientCapabilities ??
      callbackConfig.capabilities ??
      existingHttpConfig?.capabilities,
  } as HttpServerConfig;
}

function stripAuthorizationFromHttpConfig(
  config: HttpServerConfig
): HttpServerConfig {
  const headers = omitAuthorizationHeader(
    extractRequestHeaders(config.requestInit)
  );
  const requestInit = config.requestInit
    ? {
        ...config.requestInit,
      }
    : undefined;
  if (requestInit) {
    if (headers) {
      requestInit.headers = headers;
    } else {
      delete requestInit.headers;
    }
  }
  return {
    ...config,
    ...(requestInit ? { requestInit } : {}),
  };
}

/**
 * Saves OAuth-related configuration to localStorage for reconnection purposes.
 * This persists server URL, scopes, headers, and non-secret client metadata.
 */
function saveOAuthConfigToLocalStorage(formData: ServerFormData): void {
  if (HOSTED_MODE) {
    return;
  }

  if (formData.type !== "http" || !formData.useOAuth || !formData.url) {
    return;
  }

  localStorage.setItem(`mcp-serverUrl-${formData.name}`, formData.url);

  const oauthConfig: Record<string, unknown> = {};
  const existingOAuthConfig = readStoredOAuthConfig(formData.name);
  const protocolMode = formData.oauthProtocolMode ?? "auto";
  const registrationMode =
    formData.registrationMode ??
    (formData.clientId || formData.clientSecret ? "preregistered" : "auto");

  oauthConfig.protocolMode = protocolMode;
  oauthConfig.registrationMode = registrationMode;
  if (protocolMode !== "auto") {
    oauthConfig.protocolVersion = protocolMode;
  }
  if (formData.oauthScopes && formData.oauthScopes.length > 0) {
    oauthConfig.scopes = formData.oauthScopes;
  }
  const hasExplicitHeaderPatch = Object.prototype.hasOwnProperty.call(
    formData.secretPatch ?? {},
    "headers"
  );
  const customHeaders = hasExplicitHeaderPatch
    ? formData.secretPatch?.headers ?? {}
    : {
        ...(existingOAuthConfig.customHeaders ?? {}),
        ...(formData.headers ?? {}),
      };
  if (Object.keys(customHeaders).length > 0) {
    oauthConfig.customHeaders = customHeaders;
  }
  if (formData.registryServerId) {
    oauthConfig.registryServerId = formData.registryServerId;
  }
  if (registrationMode !== "auto") {
    oauthConfig.registrationStrategy = registrationMode;
  }
  if (existingOAuthConfig.resourceUrl) {
    oauthConfig.resourceUrl = existingOAuthConfig.resourceUrl;
  }
  if (Object.keys(oauthConfig).length > 0) {
    localStorage.setItem(
      `mcp-oauth-config-${formData.name}`,
      JSON.stringify(oauthConfig)
    );
  }

  if (formData.clientId) {
    const clientInfo: Record<string, string> = {};
    if (formData.clientId) {
      clientInfo.client_id = formData.clientId;
    }
    localStorage.setItem(
      `mcp-client-${formData.name}`,
      JSON.stringify(clientInfo)
    );
  } else {
    localStorage.removeItem(`mcp-client-${formData.name}`);
  }
}

export function buildElectronMcpCallbackUrl(): string | null {
  if (window.isElectron || window.location.pathname !== "/oauth/callback") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (!params.get("code") && !params.get("error")) {
    return null;
  }

  // Electron-started MCP OAuth explicitly tags the state parameter so the
  // browser callback can hand control back to the desktop app without relying
  // on browser-local storage heuristics.
  if (!isElectronMcpCallbackState(params.get("state"))) {
    return null;
  }

  const callbackUrl = new URL("mcpjam://oauth/callback");
  callbackUrl.searchParams.set("flow", "mcp");

  for (const [key, value] of params.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}

const OAUTH_CONNECTION_RETRY_DELAY_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function readStoredClientCredentials(serverName: string): {
  clientId?: string;
  clientSecret?: string;
} {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "client_secret" in parsed) {
      const sanitized = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "client_secret")
      );
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify(sanitized)
      );
    }
    return {
      clientId:
        typeof parsed?.client_id === "string" && parsed.client_id.trim() !== ""
          ? parsed.client_id
          : undefined,
    };
  } catch {
    return {};
  }
}

function parseOAuthScopes(scopes?: string): string[] | undefined {
  const parsed = scopes
    ?.split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function profileHeadersToRecord(
  headers?: Array<{ key: string; value: string }>
): Record<string, string> | undefined {
  const entries = headers
    ?.map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key, value]) => key && value);

  return entries && entries.length > 0
    ? Object.fromEntries(entries)
    : undefined;
}

function buildResolvedOAuthProfile(input: {
  serverName: string;
  serverUrl: string;
  existingProfile?: OAuthTestProfile;
  storedOAuthConfig: ReturnType<typeof readStoredOAuthConfig>;
  storedClientCredentials: ReturnType<typeof readStoredClientCredentials>;
  oauthResourceUrl?: string;
}): OAuthTestProfile | undefined {
  const existingProfile = input.existingProfile;
  const storedOAuthConfig = input.storedOAuthConfig;
  const storedClientCredentials = input.storedClientCredentials;

  const protocolVersion =
    existingProfile?.protocolVersion ??
    storedOAuthConfig.protocolVersion ??
    (storedOAuthConfig.protocolMode && storedOAuthConfig.protocolMode !== "auto"
      ? storedOAuthConfig.protocolMode
      : undefined);
  const registrationStrategy =
    existingProfile?.registrationStrategy ??
    storedOAuthConfig.registrationStrategy ??
    (storedOAuthConfig.registrationMode &&
    storedOAuthConfig.registrationMode !== "auto"
      ? storedOAuthConfig.registrationMode
      : undefined);

  if (!protocolVersion || !registrationStrategy) {
    return existingProfile;
  }

  const customHeaders = existingProfile?.customHeaders?.length
    ? existingProfile.customHeaders
    : Object.entries(storedOAuthConfig.customHeaders ?? {}).map(
        ([key, value]) => ({
          key,
          value,
        })
      );

  return {
    serverUrl: input.serverUrl,
    resourceUrl:
      input.oauthResourceUrl ??
      existingProfile?.resourceUrl ??
      storedOAuthConfig.resourceUrl ??
      "",
    clientId:
      existingProfile?.clientId ?? storedClientCredentials.clientId ?? "",
    clientSecret: "",
    scopes:
      existingProfile?.scopes ?? storedOAuthConfig.scopes?.join(",") ?? "",
    customHeaders,
    protocolVersion,
    registrationStrategy,
  };
}

function buildOAuthProfileFromFormData(
  formData: ServerFormData,
  existingProfile?: OAuthTestProfile
): OAuthTestProfile | undefined {
  // XAA reuses this profile as the carrier for its resource-AS client id /
  // scopes / resource url, so it is built for XAA too (not just OAuth).
  if (
    formData.type !== "http" ||
    !(formData.useOAuth || formData.useXaa) ||
    !formData.url
  ) {
    return undefined;
  }

  const { protocolVersion } = resolveOAuthProtocolSelection({
    mode: formData.oauthProtocolMode,
    legacyProtocolVersion: existingProfile?.protocolVersion,
    wireProtocolVersion: formData.mcpProtocolVersionOverride,
  });
  const registrationStrategy =
    formData.registrationMode && formData.registrationMode !== "auto"
      ? formData.registrationMode
      : existingProfile?.registrationStrategy ??
        (formData.clientId || formData.clientSecret || formData.hasClientSecret
          ? "preregistered"
          : "dcr");
  const customHeaders = Object.entries(formData.headers ?? {})
    .filter(([key, value]) => key.trim() && value)
    .map(([key, value]) => ({ key, value }));

  return {
    serverUrl: formData.url,
    resourceUrl: existingProfile?.resourceUrl ?? "",
    clientId: formData.clientId ?? existingProfile?.clientId ?? "",
    clientSecret: "",
    scopes: formData.oauthScopes?.join(",") ?? existingProfile?.scopes ?? "",
    customHeaders,
    protocolVersion,
    registrationStrategy,
  };
}

function restorePathAfterOAuthCallback(
  currentPathname: string,
  savedTarget: string
): string {
  const basePath =
    currentPathname === "/oauth/callback"
      ? routePaths.servers
      : currentPathname;
  return savedTarget
    ? normalizeReturnTargetPath(savedTarget, basePath)
    : basePath;
}

function requiresFreshOAuthAuthorization(error: unknown): boolean {
  const errorMessage =
    typeof error === "string"
      ? error
      : error instanceof Error
      ? error.message
      : "";

  if (!errorMessage) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("requires oauth authentication") ||
    normalized.includes("no hosted oauth credential found") ||
    normalized.includes(
      "stored hosted oauth credential is missing refresh_token"
    ) ||
    (normalized.includes("authentication failed") &&
      normalized.includes("invalid_token"))
  );
}

/**
 * Structured-first detection of "this connect needs an interactive OAuth
 * flow". The connect surfaces tag a live 401 from a discover attempt
 * (non-XAA auto, no stored token) with `oauthRequired: true` — top-level on
 * the local envelope (respondWithLocalRouteError spreads details), threaded
 * through `safeValidateHostedServer` on the hosted one. The string heuristic
 * stays as the fallback for pre-tagging server responses and thrown errors.
 */
function connectFailureRequiresOAuth(
  result: { error?: string; oauthRequired?: unknown } | null | undefined
): boolean {
  if (result?.oauthRequired === true) return true;
  return requiresFreshOAuthAuthorization(result?.error);
}

export function shouldRetryOAuthConnectionFailure(
  errorMessage?: string
): boolean {
  if (!errorMessage) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes("authentication failed") ||
    normalized.includes("invalid_client") ||
    normalized.includes("unauthorized_client")
  ) {
    return false;
  }

  return (
    normalized.includes("request timed out") ||
    normalized.includes("streamable http error") ||
    (normalized.includes("non-200 status code") && normalized.includes("404"))
  );
}

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface RegistryOAuthConfigResponse {
  clientId?: string;
  scopes?: string[];
}

interface ResolvedOAuthInitiationInputs {
  clientId?: string;
  clientSecret?: string;
  hasClientSecret: boolean;
  registryServerId?: string;
  scopes?: string[];
  useRegistryOAuthProxy: boolean;
}

interface UseServerStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when a signed-in WorkOS user is present (not guest Convex-only auth). */
  hasSignedInUser: boolean;
  isAuthLoading: boolean;
  isLoadingProjects: boolean;
  useLocalFallback: boolean;
  activeOrganizationId?: string;
  /**
   * Re-applies an organization as the user's explicit selection. Called when
   * an OAuth callback settles, with the organization the flow was pinned to,
   * so the post-callback UI returns to the org the user connected from
   * (routes like /servers carry no org of their own).
   */
  restoreActiveOrganizationId?: (organizationId: string) => void;
  effectiveProjects: Record<string, Project>;
  effectiveActiveProjectId: string;
  activeProjectServersFlat: RemoteServer[] | undefined;
  /**
   * The active project default hostConfig's mcpProfile envelope, when
   * one is set. Supplied by `use-app-state` via the
   * `hostConfigsV2.getProjectDefault` query. `undefined` means "use SDK
   * defaults" — preserves historical wire behavior on /api/mcp/connect
   * for users who haven't opted into mcpProfile. Forwarded by every
   * resolver-path connect site into ConnectionDefaults so the SDK pins
   * clientInfo / supportedProtocolVersions accordingly.
   */
  activeMcpProfile?: import("@/lib/client-config-v2").HostConfigMcpProfileV1;
  /**
   * When a named host is active (e.g. selected in ChatTabV2 or HostBuilderView
   * preview), its connectionDefaults replace the project-level connection
   * defaults in `withProjectConnectionDefaults`. Per-server overrides are
   * applied when the call site also supplies the `serverId`.
   */
  activeHostConfig?: HostConfigDtoV2;
  requestSignIn?: () => void | Promise<void>;
  logger: LoggerLike;
}

export type PersistRuntimeServerResult =
  | "noop"
  | "pending"
  | "persisted"
  | "skipped_existing_name"
  | "skipped_project_servers_unresolved"
  | "failed";

const PROJECT_SERVERS_SNAPSHOT_WAIT_MS = 10_000;
/** Must stay below Vitest's default 30s test timeout so callers can finish after a full wait + margin. */
const PROJECT_SERVER_ECHO_WAIT_MS = 25_000;
const PROJECT_SERVERS_POLL_MS = 100;
const SERVER_PROJECT_ORG_MISMATCH_ERROR_MESSAGE =
  "Cannot save server: the selected project is not in the active organization. Refresh and try again.";

function remoteServerBelongsToProject(
  server: RemoteServer,
  projectId: string | null | undefined
): boolean {
  if (!projectId) return false;
  const rowProjectId = (server as { projectId?: string }).projectId;
  return !rowProjectId || rowProjectId === projectId;
}

export interface ServerUpdateResult {
  ok: boolean;
  serverName: string;
}

export type EnsureServerConnectionStatus =
  | "connected"
  | "failed"
  | "missing"
  | "reauth"
  // A newer connect/reconnect op for the same server started while this one
  // was in flight (stale op token). The connection isn't failing — it's just
  // still in progress under the newer op, which now owns the outcome. Callers
  // should treat this as "leave it alone", NOT as a reconnect failure, so it
  // never surfaces a spurious "Failed to reconnect" toast.
  | "superseded";

export interface EnsureServerConnectionResult {
  status: EnsureServerConnectionStatus;
  error?: string;
}

interface ReconnectServerInternalOptions {
  forceOAuthFlow?: boolean;
  allowInteractiveOAuthFlow?: boolean;
  select?: boolean;
  suppressErrors?: boolean;
}

type StatelessProtocolConnectAttempt =
  | "direct"
  | "forced_oauth"
  | "synced_oauth_credentials"
  | "authorized_reconnect"
  | "protocol_revalidation";

type StatelessProtocolConnectMetadata = ReturnType<
  typeof standardEventProps
> & {
  mcp_protocol_version: McpProtocolVersion;
  protocol_pin_source: "server_override" | "host_default" | "unknown";
  connection_transport: string;
  auth_mode: "oauth" | "bearer" | "none" | "unknown";
  hosted_mode: boolean;
  has_project_context: boolean;
  has_host_config: boolean;
  has_mcp_profile: boolean;
  has_timeout_ms: boolean;
  connection_defaults_header_count: number;
  client_capability_count: number;
  has_client_info: boolean;
  supported_protocol_version_count: number;
  reconnect_attempt: StatelessProtocolConnectAttempt;
  reconnect_attempt_index: number;
  reconnect_select: boolean;
  reconnect_suppressed_errors: boolean;
  allow_interactive_oauth_flow: boolean;
  had_synced_oauth_retry: boolean;
};

type StatelessProtocolConnectTelemetry = {
  attempt?: StatelessProtocolConnectAttempt;
  attemptIndex?: number;
  select?: boolean;
  suppressErrors?: boolean;
  allowInteractiveOAuthFlow?: boolean;
  hadSyncedOAuthRetry?: boolean;
  capture?: (metadata: StatelessProtocolConnectMetadata) => void;
};

function getConnectionTransport(serverConfig: MCPServerConfig): string {
  const configuredType = (serverConfig as { type?: unknown }).type;
  if (typeof configuredType === "string" && configuredType.trim() !== "") {
    return configuredType;
  }
  if ("url" in serverConfig) return "http";
  if ("command" in serverConfig) return "stdio";
  return "unknown";
}

/**
 * The single source of truth for a connection's effective wire protocol
 * version. Every server-specific signal beats the broad host default; the
 * host default is a blanket setting used only when nothing server-specific
 * applies. Used by both the connect resolver and the connected-server
 * revalidation effect so the "which version" answer can't drift between
 * "what we connect with" and "when we re-test".
 *
 * Precedence: explicit per-server override → explicit pin on the config being
 * connected → explicit pin on the canonical stored `server.config` (recovers
 * the pin when a caller passes a rebuilt URL-only config) → a legacy record's
 * concrete OAuth profile → host default. A canonical Auto record never turns
 * its last resolved profile back into a wire pin.
 */
export function resolveEffectiveWireProtocolVersion(input: {
  serverConfig: MCPServerConfig | undefined;
  server: ServerWithName | undefined;
  serverOverride: McpProtocolVersion | undefined;
  hostPin: McpProtocolVersion | undefined;
}): McpProtocolVersion | undefined {
  const { serverConfig, server, serverOverride, hostPin } = input;
  const readConfigPin = (
    config: MCPServerConfig | undefined
  ): McpProtocolVersion | undefined => {
    const raw =
      config && "mcpProtocolVersion" in config
        ? config.mcpProtocolVersion
        : undefined;
    return typeof raw === "string" && isKnownProtocolVersion(raw)
      ? raw
      : undefined;
  };
  const configPin = readConfigPin(serverConfig);
  // Fall back to the canonical stored config so a probe/reconnect that was
  // handed a slim URL-only config (which drops the pin) still recovers the
  // wire era the server was saved with.
  const canonicalConfigPin = readConfigPin(server?.config);
  const canonicalOauthMode = server?.oauthProtocolMode;
  const oauthProfilePin: McpProtocolVersion | undefined =
    server?.useOAuth === true &&
    server.oauthFlowProfile?.protocolVersion === "2026-07-28" &&
    (canonicalOauthMode === undefined || canonicalOauthMode === "2026-07-28")
      ? "2026-07-28"
      : undefined;
  return (
    serverOverride ??
    configPin ??
    canonicalConfigPin ??
    oauthProfilePin ??
    hostPin
  );
}

function countRecordKeys(value: unknown): number {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

export interface EnsureServersReadyResult {
  readyServerNames: string[];
  missingServerNames: string[];
  failedServerNames: string[];
  reauthServerNames: string[];
}

/**
 * The ONLY channel by which secrets travel from form data to persistence.
 *
 * `syncServerToConvex` writes `env` / `headers` exclusively from what this
 * returns, and reads key PRESENCE as intent (absent = leave alone, `{}` =
 * clear, value = replace). Plain `formData.env` / `formData.headers` never
 * reach it — they configure the in-memory connection only — which is the trap
 * every import-shaped producer has to know about; see `ServerFormData.secretPatch`.
 *
 * Extracted and exported so that contract is unit-testable in one place rather
 * than re-derived inline by each caller.
 */
export function buildSecretSyncOptions(formData: ServerFormData): {
  clientSecret?: string;
  clearClientSecret?: boolean;
  clearXaaConfig?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
} {
  return {
    ...(formData.clientSecret ? { clientSecret: formData.clientSecret } : {}),
    ...(formData.clearClientSecret ? { clearClientSecret: true } : {}),
    // One-shot XAA-config reset (modal moved the server off XAA).
    ...(formData.clearXaaConfig ? { clearXaaConfig: true } : {}),
    ...(formData.secretPatch?.env !== undefined
      ? { env: formData.secretPatch.env }
      : {}),
    ...(formData.secretPatch?.headers !== undefined
      ? { headers: formData.secretPatch.headers }
      : {}),
  };
}

/**
 * What a `syncServerToConvex` call did. A bare `string | undefined` could not
 * separate "nothing was written" from "written, here is the id", so callers
 * that only checked truthiness reported success for a save that never happened.
 *
 * `not-saved` deliberately covers every pre-existing way the sync declines to
 * return an id — local-fallback mode, no authenticated user, no project, or a
 * failed write — because callers already treat those alike. Only
 * `workspace-name-taken` is new: the name belongs to another project in this
 * workspace, no retry will clear it, and the user has to rename.
 */
type ServerSyncResult =
  | { ok: true; projectId: string; serverId: string }
  | { ok: false; reason: "not-saved" }
  | { ok: false; reason: "workspace-name-taken"; takenByProjectId?: string };

const SERVER_NOT_SAVED: ServerSyncResult = { ok: false, reason: "not-saved" };

export function useServerState({
  appState,
  dispatch,
  isLoading,
  isAuthenticated,
  hasSignedInUser,
  isAuthLoading,
  isLoadingProjects,
  useLocalFallback,
  activeOrganizationId,
  restoreActiveOrganizationId,
  effectiveProjects,
  effectiveActiveProjectId,
  activeProjectServersFlat,
  activeMcpProfile,
  activeHostConfig,
  requestSignIn,
  logger,
}: UseServerStateParams) {
  const isUserReady = useDbUserReady();
  const convex = useConvex();
  const {
    createServerIfMissing: convexCreateServerIfMissing,
    updateServer: convexUpdateServer,
    createServerWithClientSecret: convexCreateServerWithClientSecret,
    updateServerWithClientSecret: convexUpdateServerWithClientSecret,
    deleteServer: convexDeleteServer,
  } = useServerMutations();

  // Which client the toast's "Change protocol version" should open. Held in a
  // ref because the connect callback is memoized on a long dependency list and
  // this is read only at click time — adding it as a dep would rebuild that
  // callback on every host preview switch for a value nothing else uses.
  const [previewedHostIdForToast] = usePreviewedHostId(
    effectiveActiveProjectId ?? null
  );
  const previewedHostIdRef = useRef(previewedHostIdForToast);
  previewedHostIdRef.current = previewedHostIdForToast;

  const hasSignedInUserRef = useRef(hasSignedInUser);
  hasSignedInUserRef.current = hasSignedInUser;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isUserReadyRef = useRef(isUserReady);
  isUserReadyRef.current = isUserReady;
  const isAuthLoadingRef = useRef(isAuthLoading);
  isAuthLoadingRef.current = isAuthLoading;
  const isLoadingProjectsRef = useRef(isLoadingProjects);
  isLoadingProjectsRef.current = isLoadingProjects;
  const useLocalFallbackRef = useRef(useLocalFallback);
  useLocalFallbackRef.current = useLocalFallback;
  const effectiveActiveProjectIdRef = useRef(effectiveActiveProjectId);
  effectiveActiveProjectIdRef.current = effectiveActiveProjectId;
  const activeOrganizationIdRef = useRef(activeOrganizationId);
  activeOrganizationIdRef.current = activeOrganizationId;
  const effectiveProjectsRef = useRef(effectiveProjects);
  effectiveProjectsRef.current = effectiveProjects;
  const appStateServersRef = useRef(appState.servers);
  appStateServersRef.current = appState.servers;
  const activeProjectServersFlatRef = useRef(activeProjectServersFlat);
  activeProjectServersFlatRef.current = activeProjectServersFlat;
  const persistRuntimeDedupeKeysRef = useRef<Set<string>>(new Set());
  // handleRemoveServer is declared further down the hook, so the rename branch
  // in saveServerConfigWithoutConnecting reaches it through a ref rather than a
  // dependency (a dep array entry would evaluate before the const initializes).
  const handleRemoveServerRef = useRef<
    | ((
        serverName: string,
        options?: { removeFromCloud?: boolean }
      ) => Promise<void>)
    | null
  >(null);

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const oauthCallbackHandledRef = useRef(false);
  const opTokenRef = useRef<Map<string, number>>(new Map());
  const nextOpToken = (name: string) => {
    const current = opTokenRef.current.get(name) ?? 0;
    const next = current + 1;
    opTokenRef.current.set(name, next);
    return next;
  };

  const failPendingOAuthConnection = useCallback(
    (errorMessage: string, oauthTrace?: OAuthTrace) => {
      const pendingServerName = localStorage.getItem(OAUTH_PENDING_STORAGE_KEY);
      if (pendingServerName) {
        dispatch({
          type: "CONNECT_FAILURE",
          name: pendingServerName,
          error: errorMessage,
          oauthTrace,
        });
      }

      clearHostedOAuthPendingState();
      localStorage.removeItem("mcp-oauth-return-hash");
      localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY);

      return pendingServerName;
    },
    [dispatch]
  );
  const updateServerOAuthTrace = useCallback(
    (serverName: string, oauthTrace: OAuthTrace) => {
      dispatch({
        type: "SET_SERVER_OAUTH_TRACE",
        name: serverName,
        oauthTrace,
      });
    },
    [dispatch]
  );
  const isStaleOp = (name: string, token: number) =>
    (opTokenRef.current.get(name) ?? 0) !== token;

  // Pins the org/project/server the OAuth flow starts from so the callback
  // can write back to the same rows. Written in BOTH hosted and local modes:
  // local-mode completion runs client-side, but the post-callback Convex sync
  // is identical, and without the pin it targets whatever project is active
  // after the redirect remount (the fallback org's default project).
  // Hosted-only behavior (the backend session) stays gated inside
  // createHostedOAuthSessionIfNeeded, which checks HOSTED_MODE itself.
  const prepareHostedProjectOAuthRedirect = useCallback(
    (params: {
      serverId?: string | null;
      serverName: string;
      serverUrl?: string | null;
    }): boolean => {
      if (
        !isAuthenticated ||
        !effectiveActiveProjectId ||
        !params.serverId ||
        !params.serverUrl
      ) {
        return false;
      }

      const returnPath = captureCurrentReturnPath();
      const organizationId =
        effectiveProjects[effectiveActiveProjectId]?.organizationId ?? null;
      clearHostedOAuthPendingState();
      writeHostedOAuthPendingMarker({
        surface: "project",
        organizationId,
        projectId: effectiveActiveProjectId,
        serverId: params.serverId,
        serverName: params.serverName,
        serverUrl: params.serverUrl,
        accessScope: "project_member",
        returnPath,
      });
      if (returnPath) {
        localStorage.setItem("mcp-oauth-return-hash", returnPath);
      }
      return true;
    },
    [effectiveActiveProjectId, effectiveProjects, isAuthenticated]
  );

  const activeProject = useMemo(() => {
    const project = effectiveProjects[effectiveActiveProjectId];
    if (!project) {
      return undefined;
    }

    const serversWithRuntime: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(project.servers)) {
      const runtimeState = appState.servers[name];
      const runtimeHasBearerToken = getServerBearerTokenState(runtimeState);
      const projectHasBearerToken = getServerBearerTokenState(server);
      // Env now lives on the Convex server doc and is returned by the
      // resolver inside `server.config.env`; no localStorage read needed.
      serversWithRuntime[name] = {
        ...server,
        config: server.config,
        connectionStatus: runtimeState?.connectionStatus || "disconnected",
        // Why the last attempt failed. Convex server rows do not store it, so
        // omitting it here left a hosted card reading "Failed" with an empty
        // error area and an empty Overview: the toast was the only copy of the
        // reason, and it vanished with the toast (BB-48). Sourced from runtime
        // state ONLY — exactly like `connectionStatus` above — so a reload that
        // drops the runtime drops the reason with it instead of showing a stale
        // one next to a "disconnected" status.
        lastError: runtimeState?.lastError,
        lastNormalizedError: runtimeState?.lastNormalizedError,
        lastOAuthTrace: runtimeState?.lastOAuthTrace,
        oauthTokens: runtimeState?.oauthTokens,
        initializationInfo: runtimeState?.initializationInfo,
        lastConnectionTime:
          runtimeState?.lastConnectionTime || server.lastConnectionTime,
        retryCount: runtimeState?.retryCount || 0,
        hasClientSecret:
          runtimeState?.hasClientSecret ?? server.hasClientSecret,
        hasEnv: runtimeState?.hasEnv ?? server.hasEnv,
        hasHeaders: runtimeState?.hasHeaders ?? server.hasHeaders,
        hasBearerToken: runtimeHasBearerToken ?? projectHasBearerToken,
      };
    }

    if (!isAuthenticated || useLocalFallback) {
      // Surface runtime-only servers only in local/fallback state. For
      // Convex-backed projects the server list must come from the Convex
      // project-server queries, otherwise runtime state can leak across
      // logout, guest handoff, or organization switches.
      for (const [name, runtime] of Object.entries(appState.servers)) {
        if (serversWithRuntime[name]) continue;
        if (
          runtime.connectionStatus !== "connected" &&
          runtime.connectionStatus !== "connecting"
        ) {
          continue;
        }
        serversWithRuntime[name] = runtime;
      }
    }

    return { ...project, servers: serversWithRuntime };
  }, [
    effectiveProjects,
    effectiveActiveProjectId,
    appState.servers,
    isAuthenticated,
    useLocalFallback,
  ]);

  const effectiveServers = useMemo(() => {
    return activeProject?.servers || {};
  }, [activeProject]);

  const connectedOrConnectingServerConfigs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(effectiveServers).filter(
          ([, server]) =>
            server.connectionStatus === "connected" ||
            server.connectionStatus === "connecting"
        )
      ),
    [effectiveServers]
  );

  // What chat-input's "Servers" popover (and any other "show me everything
  // we can talk to" surface) should iterate. In Convex-backed projects this
  // must be the project catalog only: runtime-only entries are global app
  // state and can otherwise bleed across organization/project switches.
  // Local/fallback mode still merges connected/connecting runtime entries
  // because there is no scoped Convex project-server catalog to wait for.
  const displayServerConfigs = useMemo(() => {
    const result: Record<string, ServerWithName> = { ...effectiveServers };
    if (isAuthenticated && !useLocalFallback) {
      return result;
    }
    for (const [name, runtime] of Object.entries(appState.servers)) {
      if (result[name]) continue;
      if (
        runtime.connectionStatus !== "connected" &&
        runtime.connectionStatus !== "connecting"
      ) {
        continue;
      }
      result[name] = runtime;
    }
    return result;
  }, [effectiveServers, appState.servers, isAuthenticated, useLocalFallback]);

  const latestEffectiveServersRef = useRef(effectiveServers);

  useEffect(() => {
    latestEffectiveServersRef.current = effectiveServers;
  }, [effectiveServers]);

  const isClientConfigSyncPending = useProjectClientConfigSyncPending(
    effectiveActiveProjectId
  );

  const projectConnectionDefaults = useMemo(
    () => getEffectiveProjectConnectionDefaults(activeProject?.clientConfig),
    [activeProject?.clientConfig]
  );

  const withProjectConnectionDefaults = useCallback(
    (serverConfig: MCPServerConfig, serverId?: string): MCPServerConfig => {
      // Capability precedence: per-server explicit override → active host
      // (always the single source for the global tab scope) → project
      // clientConfig shadow (transient, only when activeHostConfig hasn't
      // hydrated yet). The host is the only authoritative source once
      // provisioned — `projects.clientConfig` is a backend-maintained
      // shadow-mirror of the project default host.
      const effectiveClientCapabilities = activeHostConfig
        ? resolveEffectiveClientCapabilities({
            host: activeHostConfig,
            serverConfig,
          })
        : resolveEffectiveClientCapabilities({
            host: activeProject?.clientConfig
              ? ({
                  clientCapabilities:
                    activeProject.clientConfig.clientCapabilities,
                } as Pick<HostConfigDtoV2, "clientCapabilities">)
              : null,
            serverConfig,
          });

      // Hoisted above the transport split: the per-server override applies to
      // stdio too. Its only field that means anything off HTTP is the timeout,
      // but that one does apply — a slow stdio server needs the same escape
      // hatch as a slow HTTP one.
      const perServerOverride =
        serverId && activeHostConfig
          ? activeHostConfig.serverConnectionOverrides?.[serverId]
          : undefined;

      let nextRequestInit = serverConfig.requestInit;
      if ("url" in serverConfig) {
        let mergedHeaders: Record<string, string>;
        let effectiveTimeout: number;

        if (activeHostConfig) {
          // Use host-level connection defaults + optional per-server override
          const serverBase = {
            headers: extractRequestHeaders(serverConfig.requestInit),
            timeout: serverConfig.timeout,
          };
          const resolved = resolveServerConnectionSettings(
            serverBase,
            activeHostConfig.connectionDefaults,
            perServerOverride
          );
          mergedHeaders = resolved.headers;
          effectiveTimeout = resolved.timeout;
        } else {
          mergedHeaders = mergeProjectConnectionHeaders(
            projectConnectionDefaults.headers,
            extractRequestHeaders(serverConfig.requestInit)
          );
          effectiveTimeout =
            serverConfig.timeout ?? projectConnectionDefaults.requestTimeout;
        }

        if (Object.keys(mergedHeaders).length > 0) {
          nextRequestInit = {
            ...(serverConfig.requestInit ?? {}),
            headers: mergedHeaders,
          };
        }

        return {
          ...serverConfig,
          ...(nextRequestInit ? { requestInit: nextRequestInit } : {}),
          timeout: effectiveTimeout,
          capabilities: effectiveClientCapabilities,
          clientCapabilities: effectiveClientCapabilities,
        } as MCPServerConfig;
      }

      // stdio. Same precedence rule as the HTTP branch above, via the same
      // helper — an inline copy of the ladder is what let the two transports
      // drift apart in the first place (issue #3671).
      return {
        ...serverConfig,
        timeout: activeHostConfig
          ? resolveServerConnectionSettings(
              { timeout: serverConfig.timeout },
              activeHostConfig.connectionDefaults,
              perServerOverride
            ).timeout
          : serverConfig.timeout ?? projectConnectionDefaults.requestTimeout,
        capabilities: effectiveClientCapabilities,
        clientCapabilities: effectiveClientCapabilities,
      } as MCPServerConfig;
    },
    [activeProject?.clientConfig, projectConnectionDefaults, activeHostConfig]
  );

  const mergeWithProjectHeaders = useCallback(
    (headers?: Record<string, string>) => {
      const merged = mergeProjectConnectionHeaders(
        projectConnectionDefaults.headers,
        omitAuthorizationHeader(headers)
      );
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    [projectConnectionDefaults.headers]
  );

  const assertClientConfigSynced = useCallback(() => {
    if (!isClientConfigSyncPending) {
      return;
    }

    throw new Error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
  }, [isClientConfigSyncPending]);

  const notifyIfClientConfigSyncPending = useCallback(() => {
    if (!isClientConfigSyncPending) {
      return false;
    }

    toast.error(CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE);
    return true;
  }, [isClientConfigSyncPending]);

  const isProjectProvisioned = useMemo(
    () => Boolean(activeProject?.sharedProjectId),
    [activeProject?.sharedProjectId]
  );

  const getProjectNotProvisionedError = useCallback(() => {
    if (isProjectProvisioned) {
      return null;
    }
    if (useLocalFallbackRef.current || !isAuthenticatedRef.current) {
      return null;
    }
    return PROJECT_NOT_PROVISIONED_ERROR_MESSAGE;
  }, [isProjectProvisioned]);

  const notifyIfProjectNotProvisioned = useCallback(() => {
    const errorMessage = getProjectNotProvisionedError();
    if (!errorMessage) {
      return false;
    }

    toast.error(errorMessage);
    return true;
  }, [getProjectNotProvisionedError]);

  // Extract runtime overlay applied by `withProjectConnectionDefaults` so the
  // resolver path can reproduce them server-side. Without this, the resolver
  // sees only the Convex-stored per-server config and loses project-level
  // header overlays / timeout / capabilities. HTTP servers' Authorization is
  // omitted here — OAuth bearer is reattached server-side from the Convex
  // token store.
  const buildResolverConnectionDefaults = useCallback(
    (
      serverConfig: MCPServerConfig,
      // Optional mcpProfile (hostConfig.mcpProfile) that the caller has
      // already resolved from a scenario/project context. When provided,
      // its `initialize.clientInfo` and first
      // `initialize.supportedProtocolVersions` entry flow onto the
      // ConnectionDefaults wire shape. Undefined preserves historical
      // behavior — connect runs without an mcpProfile pin and the SDK
      // falls back to its hardcoded defaults.
      mcpProfile?: import("@/lib/client-config-v2").HostConfigMcpProfileV1,
      // Server identifier used to look up per-server protocol-version
      // pins on `activeHostConfig.serverConnectionOverrides`. When
      // supplied, `resolveEffectiveMcpProtocolVersion(serverOverride,
      // hostDefault)` runs so a per-server dropdown choice actually
      // reaches the connect payload — without this argument, the host
      // default wins and per-server overrides are silently dropped (the
      // bug PR #2257 review flagged).
      serverId?: string,
      // Server name, used only to derive the sessionless 2026 wire era from
      // the server's saved OAuth profile when nothing higher-precedence pins
      // it. Every connect/probe/reconnect path funnels through this resolver,
      // so deriving here covers them all in one place.
      serverName?: string,
      // Authoritative pending server entry (a form save in flight). When
      // supplied it REPLACES the stored app-state lookup for the config/profile
      // fallbacks, so a form that downgrades 2026→2025 (an intentionally
      // unpinned config) does not resurrect the stale stored 2026 pin/profile.
      // Reconnects omit it and fall back to the stored entry as before.
      authoritativeServerEntry?: ServerWithName
    ) => {
      const defaults: ConnectionDefaults = {};
      if ("url" in serverConfig) {
        const headers = omitAuthorizationHeader(
          extractRequestHeaders(serverConfig.requestInit)
        );
        if (headers && Object.keys(headers).length > 0) {
          defaults.headers = headers;
        }
      }
      if (typeof serverConfig.timeout === "number") {
        defaults.timeoutMs = serverConfig.timeout;
      }
      const caps = serverConfig.clientCapabilities as
        | Record<string, unknown>
        | undefined;
      if (caps && typeof caps === "object") defaults.clientCapabilities = caps;
      const ci = mcpProfile?.initialize?.clientInfo;
      if (ci && typeof ci === "object" && !Array.isArray(ci)) {
        defaults.clientInfo = ci;
      }
      const versions = mcpProfile?.initialize?.supportedProtocolVersions;
      if (Array.isArray(versions) && versions.length > 0) {
        // Forward the full accept-list. First entry is what the SDK
        // proposes in `initialize.params.protocolVersion`; later entries
        // are accepted if the server negotiates one of them. Collapsing
        // to `[versions[0]]` was the prior shape and silently caused
        // "server speaks a later listed version → connect fails," which
        // defeats the point of letting users pin a multi-version list.
        defaults.supportedProtocolVersions = versions.filter(
          (v): v is string => typeof v === "string" && v.trim() !== ""
        );
      }
      // Effective pinned MCP protocol version: per-server override
      // (from `activeHostConfig.serverConnectionOverrides[serverId]
      // .mcpProtocolVersionOverride`) wins, otherwise the host default
      // from `mcpProfile.mcpProtocolVersion`, otherwise undefined
      // (preserves "SDK chooses" semantics). Membership-gate each
      // candidate via `isKnownProtocolVersion` so a typo on either
      // layer doesn't slip past to the SDK's open-routing predicate.
      const rawServerOverride =
        serverId && activeHostConfig
          ? activeHostConfig.serverConnectionOverrides?.[serverId]
              ?.mcpProtocolVersionOverride
          : undefined;
      const serverOverride: McpProtocolVersion | undefined =
        typeof rawServerOverride === "string" &&
        isKnownProtocolVersion(rawServerOverride)
          ? rawServerOverride
          : undefined;
      const rawHostPin = mcpProfile?.mcpProtocolVersion;
      const hostPin: McpProtocolVersion | undefined =
        typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
          ? rawHostPin
          : undefined;
      const resolvedProtocolVersion = resolveEffectiveWireProtocolVersion({
        serverConfig,
        // An in-flight authoritative form save wins over the stale stored
        // entry, so a 2026→2025 downgrade doesn't recover the old pin/profile.
        server:
          authoritativeServerEntry ??
          (serverName ? appStateServersRef.current[serverName] : undefined),
        serverOverride,
        hostPin,
      });
      if (resolvedProtocolVersion !== undefined) {
        defaults.mcpProtocolVersion = resolvedProtocolVersion;
      }
      // SEP-2243 `Mcp-Param-*` mirroring. Host-level only — conformance is a
      // property of the simulated CLIENT, so there is no per-server override
      // to resolve against. Only `"omit"` reaches the wire; `"mirror"` and an
      // absent field are the same instruction and leave the field off.
      if (mcpProfile?.toolParamHeaderMirroring === "omit") {
        defaults.mirrorToolParamHeaders = false;
      }
      // Sibling client-conformance knobs, same host-level/only-the-
      // non-default-value discipline as the mirroring knob above.
      if (mcpProfile?.paginationTraversal === "firstPageOnly") {
        defaults.firstPageOnly = true;
      }
      if (mcpProfile?.mrtrSupport === "none") {
        defaults.supportsMrtr = false;
      }
      // Nested record rather than an enum, but the same rule: only an
      // explicit `false` leaf travels.
      if (mcpProfile?.toolListChanged?.listens === false) {
        defaults.suppressListenChannel = true;
      }
      if (mcpProfile?.toolListChanged?.refetches === false) {
        defaults.dropToolListChanged = true;
      }
      // Enterprise-managed authorization policy from the active host's
      // mcpProfile. Sent only when validly ON; an `invalid` stored policy
      // fails the connect client-side with an actionable message instead of
      // silently connecting unenforced (fail-closed — the server re-gates).
      const policyState = readXaaEnterprisePolicy(mcpProfile);
      if (policyState.kind === "on") {
        defaults.xaaPolicy = policyState.policy;
      } else if (policyState.kind === "invalid") {
        throw new Error(
          `This host has an unsupported enterprise-managed authorization policy (${policyState.reason}). Fix it on the host's MCP Protocol tab, or turn the policy off.`
        );
      }
      return Object.keys(defaults).length > 0 ? defaults : undefined;
    },
    [activeHostConfig]
  );

  const buildStatelessProtocolConnectMetadata = useCallback(
    (
      serverName: string,
      serverConfig: MCPServerConfig,
      serverId: string,
      connectionDefaults: ConnectionDefaults | undefined,
      effectiveProtocolVersion: McpProtocolVersion,
      telemetry?: StatelessProtocolConnectTelemetry
    ): StatelessProtocolConnectMetadata => {
      const server =
        latestEffectiveServersRef.current[serverName] ??
        appStateServersRef.current[serverName];
      const usesOAuth = server?.useOAuth === true;
      const hasBearerToken = getServerBearerTokenState(server) === true;
      const rawServerOverride =
        activeHostConfig?.serverConnectionOverrides?.[serverId]
          ?.mcpProtocolVersionOverride;
      const serverOverride =
        typeof rawServerOverride === "string" &&
        isKnownProtocolVersion(rawServerOverride)
          ? rawServerOverride
          : undefined;
      const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
      const hostPin =
        typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
          ? rawHostPin
          : undefined;
      const protocolPinSource =
        serverOverride === effectiveProtocolVersion
          ? "server_override"
          : hostPin === effectiveProtocolVersion
          ? "host_default"
          : "unknown";

      return {
        ...standardEventProps("use_server_state"),
        mcp_protocol_version: effectiveProtocolVersion,
        protocol_pin_source: protocolPinSource,
        connection_transport: getConnectionTransport(serverConfig),
        auth_mode: usesOAuth ? "oauth" : hasBearerToken ? "bearer" : "none",
        hosted_mode: HOSTED_MODE,
        has_project_context: true,
        has_host_config: Boolean(activeHostConfig),
        has_mcp_profile: Boolean(activeMcpProfile),
        has_timeout_ms: typeof connectionDefaults?.timeoutMs === "number",
        connection_defaults_header_count: countRecordKeys(
          connectionDefaults?.headers
        ),
        client_capability_count: countRecordKeys(
          connectionDefaults?.clientCapabilities
        ),
        has_client_info: Boolean(connectionDefaults?.clientInfo),
        supported_protocol_version_count:
          connectionDefaults?.supportedProtocolVersions?.length ?? 0,
        reconnect_attempt: telemetry?.attempt ?? "direct",
        reconnect_attempt_index: telemetry?.attemptIndex ?? 1,
        reconnect_select: telemetry?.select ?? true,
        reconnect_suppressed_errors: telemetry?.suppressErrors ?? false,
        allow_interactive_oauth_flow:
          telemetry?.allowInteractiveOAuthFlow ?? false,
        had_synced_oauth_retry: telemetry?.hadSyncedOAuthRetry ?? false,
      };
    },
    [activeHostConfig, activeMcpProfile]
  );

  const guardedTestConnection = useCallback(
    async (
      serverConfig: MCPServerConfig,
      serverName: string,
      // The authoritative pending server entry when this probe is part of a
      // form save (handleConnect). Threaded into the resolver so wire-era
      // resolution reads the new config/profile, not the stale stored one.
      authoritativeServerEntry?: ServerWithName,
      syncedTarget?: { projectId: string; serverId: string }
    ) => {
      assertClientConfigSynced();
      // Local and hosted connections both require a Convex project/server id.
      // A brand-new save passes its just-created target directly so this probe
      // does not race the reactive API-context mapping; older rows resolve
      // through the normal name-to-id context.
      const resolved = syncedTarget ?? tryResolveProjectServer(serverName);
      if (resolved) {
        // Re-resolve WITH the Convex serverId. Callers already applied
        // `withProjectConnectionDefaults`, but they only know the display
        // name, so the `serverConnectionOverrides[serverId]` layer was skipped
        // and a per-server timeout override landed only on the NEXT connect.
        // `guardedReconnectServer` re-resolves the same way for the same
        // reason — which is why reconnects honored it and first connects did
        // not. Applying it here makes the two paths agree.
        const configWithDefaults = withProjectConnectionDefaults(
          serverConfig,
          resolved.serverId
        );
        return testConnection(configWithDefaults, resolved.serverId, {
          projectId: resolved.projectId,
          serverName,
          // Forward the active mcpProfile so the resolver path pins
          // clientInfo / supportedProtocolVersions on this connect.
          // Undefined preserves SDK defaults — no behavior change for
          // users without an mcpProfile.
          connectionDefaults: buildResolverConnectionDefaults(
            configWithDefaults,
            activeMcpProfile,
            resolved.serverId,
            serverName,
            authoritativeServerEntry
          ),
        });
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [
      assertClientConfigSynced,
      buildResolverConnectionDefaults,
      withProjectConnectionDefaults,
      activeMcpProfile,
    ]
  );

  const guardedReconnectServer = useCallback(
    async (
      serverName: string,
      serverConfig: MCPServerConfig,
      telemetry?: StatelessProtocolConnectTelemetry
    ) => {
      assertClientConfigSynced();
      const resolved = tryResolveProjectServer(serverName);
      if (resolved) {
        const configWithDefaults = withProjectConnectionDefaults(
          serverConfig,
          resolved.serverId
        );
        // The 2026 wire era (from the server's saved OAuth profile) is derived
        // inside `buildResolverConnectionDefaults` via `serverName`, so it
        // covers this reconnect path and the connect/probe paths uniformly.
        const connectionDefaults = buildResolverConnectionDefaults(
          configWithDefaults,
          activeMcpProfile,
          resolved.serverId,
          serverName
        );
        const effectiveProtocolVersion = connectionDefaults?.mcpProtocolVersion;
        const result = await reconnectServer(
          resolved.serverId,
          configWithDefaults,
          {
            projectId: resolved.projectId,
            serverName,
            connectionDefaults,
          }
        );
        if (
          result?.success &&
          effectiveProtocolVersion &&
          isStatelessProtocolVersion(effectiveProtocolVersion)
        ) {
          const metadata = buildStatelessProtocolConnectMetadata(
            serverName,
            configWithDefaults,
            resolved.serverId,
            connectionDefaults,
            effectiveProtocolVersion,
            telemetry
          );
          if (telemetry?.capture) {
            telemetry.capture(metadata);
          } else {
            track("stateless_protocol_connect", metadata);
          }
        }
        return result;
      }
      throw new Error(PROJECT_NOT_PROVISIONED_ERROR_MESSAGE);
    },
    [
      assertClientConfigSynced,
      buildResolverConnectionDefaults,
      activeMcpProfile,
      withProjectConnectionDefaults,
      buildStatelessProtocolConnectMetadata,
    ]
  );

  // Shared with the forms that feed this save path (XAAServerModal, ...) so a
  // form can never pass a config the save path would reject and lose the
  // user's input. See lib/server-form-validation.
  const validateForm = validateServerFormData;

  const setSelectedMultipleServersToAllServers = useCallback(() => {
    const connectedNames = Object.entries(appState.servers)
      .filter(([, s]) => s.connectionStatus === "connected")
      .map(([name]) => name);
    dispatch({ type: "SET_MULTI_SELECTED", names: connectedNames });
  }, [appState.servers, dispatch]);

  const syncServerToConvex = useCallback(
    async (
      serverName: string,
      serverEntry: ServerWithName,
      secretOptions?: {
        clientSecret?: string;
        clearClientSecret?: boolean;
        // One-shot command (like clearClientSecret): resets the sticky XAA
        // identity config server-side. Rides the call, never app state — a
        // persisted flag would re-fire on every future sync.
        clearXaaConfig?: boolean;
        env?: Record<string, string>;
        headers?: Record<string, string>;
      },
      // Explicit write target for flows that pinned their project/server
      // before a redirect (hosted OAuth). The ambient active project can
      // legitimately change while such a flow is in flight — post-callback
      // remounts resolve the fallback organization until hydration settles —
      // so a pinned target must win over the refs or the write lands in
      // whatever project happens to be active.
      target?: {
        projectId: string;
        serverId?: string | null;
        exactServerId?: boolean;
      }
    ): Promise<ServerSyncResult> => {
      const latestUseLocalFallback = useLocalFallbackRef.current;
      const latestIsAuthenticated = isAuthenticatedRef.current;
      const latestProjectId =
        target?.projectId ?? effectiveActiveProjectIdRef.current;
      if (
        latestUseLocalFallback ||
        !latestIsAuthenticated ||
        !latestProjectId ||
        latestProjectId === "none"
      ) {
        return SERVER_NOT_SAVED;
      }

      // The ambient org/project coherence guard only applies to ambient
      // writes: a pinned target is allowed to differ from the active
      // organization (that is the point of pinning).
      const latestActiveOrganizationId = activeOrganizationIdRef.current;
      if (!target && latestActiveOrganizationId) {
        const latestProject = effectiveProjectsRef.current[latestProjectId];
        const latestProjectOrganizationId = latestProject?.organizationId;
        if (latestProjectOrganizationId !== latestActiveOrganizationId) {
          logger.warn(
            "Refusing to sync server because active project does not belong to active organization",
            {
              serverName,
              projectId: latestProjectId,
              projectOrganizationId: latestProjectOrganizationId ?? null,
              activeOrganizationId: latestActiveOrganizationId,
            }
          );
          throw new Error(SERVER_PROJECT_ORG_MISMATCH_ERROR_MESSAGE);
        }
      }

      const flatSnapshot =
        activeProjectServersFlatRef.current ?? activeProjectServersFlat;

      // Preserve the exact typed value — only whether there's a real
      // replacement is trim-based (whitespace-only counts as none).
      // Trimming the value that's actually sent would silently change a
      // secret that legitimately has leading/trailing whitespace.
      const clientSecret = secretOptions?.clientSecret;
      const hasClientSecretValue = Boolean(clientSecret?.trim());
      const clearClientSecret = secretOptions?.clearClientSecret === true;
      const clearXaaConfig = secretOptions?.clearXaaConfig === true;
      const config = serverEntry.config as any;
      const headers = extractRequestHeaders(config?.requestInit);
      const hasEnvSecretPatch = Object.prototype.hasOwnProperty.call(
        secretOptions ?? {},
        "env"
      );
      const hasHeadersSecretPatch = Object.prototype.hasOwnProperty.call(
        secretOptions ?? {},
        "headers"
      );
      if (hasClientSecretValue && clearClientSecret) {
        throw new Error(
          "Cannot replace and clear the OAuth client secret in the same save."
        );
      }
      const hasSecretOperation = Boolean(
        hasClientSecretValue ||
          clearClientSecret ||
          hasEnvSecretPatch ||
          hasHeadersSecretPatch ||
          (!secretOptions && config?.env !== undefined) ||
          (!secretOptions && headers !== undefined)
      );

      // Resolve "does a server with this name already exist?" from the local
      // snapshot when possible, then fall back to a one-shot Convex query.
      // A loaded snapshot can still be stale, so a miss there is not proof
      // that this is a new server. When no row is visible after the query, the
      // no-secret write path still uses the backend create-if-missing mutation
      // so the final decision is atomic.
      //
      // `owned` is a row this project may write. `workspaceTwin` is a live row
      // with the same name owned by ANOTHER project in the same workspace:
      // `servers:getProjectServers` returns those (the list is workspace-wide,
      // by design) but `remoteServerBelongsToProject` reads them as absent.
      // That only breaks the secret path, whose create resolves a WORKSPACE
      // name clash back to the row that already holds the name and returns its
      // id with this payload never applied. `createServerWithClientSecret`
      // throws on the clash only under `failOnNameConflict`, which the v1 REST
      // route passes and this client does not. `servers:createServerIfMissing`
      // matches per PROJECT, so the no-secret path still creates our own row
      // and is left to run.
      //
      // `forceFresh` skips only the snapshot short-circuit, for the retry after
      // a failed write: the snapshot it is handed is the one that was live when
      // the mutation was issued, so trusting it would re-resolve the same row
      // and re-issue the write that just failed. The snapshot is still passed —
      // the not-yet-ready and query-error paths below have nothing else to find
      // a workspace twin in.
      const resolveExistingServer = async (
        snapshot: RemoteServer[] | undefined,
        { forceFresh = false }: { forceFresh?: boolean } = {}
      ): Promise<{ owned?: RemoteServer; workspaceTwin?: RemoteServer }> => {
        // A pinned serverId is authoritative: the row was created before the
        // OAuth redirect and the hosted session validated it. Match by id
        // first; fall back to name-within-pinned-project in case the row was
        // deleted and recreated mid-flow.
        const matches = (s: RemoteServer) =>
          target?.serverId
            ? s._id === target.serverId
            : s.name === serverName &&
              remoteServerBelongsToProject(s, latestProjectId);
        // A pinned id names one exact row, so "some other project has this
        // name" says nothing about it.
        const findWorkspaceTwin = (rows: RemoteServer[] | undefined) =>
          target?.serverId
            ? undefined
            : rows?.find(
                (s) =>
                  s.name === serverName &&
                  !remoteServerBelongsToProject(s, latestProjectId)
              );
        if (!forceFresh) {
          const local = snapshot?.find(matches);
          if (local) return { owned: local };
        }
        if (!isUserReadyRef.current) {
          return { workspaceTwin: findWorkspaceTwin(snapshot) };
        }
        try {
          const fresh = (await convex.query(
            "servers:getProjectServers" as any,
            { projectId: latestProjectId } as any
          )) as RemoteServer[] | undefined;
          const owned =
            fresh?.find(matches) ??
            // Project-scoped, as the comment on `matches` says: the list is
            // workspace-wide, so an unscoped name match here would let a
            // pinned-but-stale id land the write on a sibling project's row.
            (target?.serverId
              ? fresh?.find(
                  (s) =>
                    s.name === serverName &&
                    remoteServerBelongsToProject(s, latestProjectId)
                )
              : undefined);
          return owned
            ? { owned }
            : { workspaceTwin: findWorkspaceTwin(fresh) };
        } catch (queryError) {
          // The snapshot is all that is left, and a twin in it can now abort
          // the save — so the failure has to be visible, or a transient Convex
          // error reads as "this name is taken" with nothing to point at.
          logger.warn("Could not re-read project servers before saving", {
            serverName,
            projectId: latestProjectId,
            error:
              queryError instanceof Error
                ? queryError.message
                : "Unknown error",
          });
          return { workspaceTwin: findWorkspaceTwin(snapshot) };
        }
      };

      // The name is taken by another project in this workspace, and on the
      // secret path the create can only hand that row back unwritten. Never
      // return its id: callers bind whatever id they get to this project's
      // server — the hosted send mapping and the pinned OAuth redirect target —
      // and `servers:updateServer` authorizes by workspace role, so a later
      // pinned re-sync would write this payload onto the sibling project's
      // server. Report the collision and fail the save instead.
      const workspaceTwinConflict = (twin: RemoteServer): ServerSyncResult => {
        logger.warn(
          "Server name already belongs to another project in this workspace",
          {
            serverName,
            projectId: latestProjectId,
            existingServerId: twin._id,
            existingProjectId: twin.projectId,
          }
        );
        return {
          ok: false,
          reason: "workspace-name-taken",
          takenByProjectId: twin.projectId,
        };
      };

      // The twin guard above can only fire on a twin the resolve could see. A
      // stale query — or a sibling project that won the name between the
      // resolve and the create — leaves the secret-path create to resolve the
      // clash itself, and it does that by handing back the id of the row that
      // already holds the name with this payload never applied. That reads as
      // a successful create. Confirm the row we were handed is this project's
      // before reporting a save that never touched it.
      const confirmSecretCreateIsOurs = async (
        newServerId: string
      ): Promise<ServerSyncResult> => {
        const ok: ServerSyncResult = {
          ok: true,
          projectId: latestProjectId,
          serverId: newServerId,
        };
        if (!isUserReadyRef.current) return ok;
        let rows: RemoteServer[] | undefined;
        try {
          rows = (await convex.query(
            "servers:getProjectServers" as any,
            {
              projectId: latestProjectId,
            } as any
          )) as RemoteServer[] | undefined;
        } catch (verifyError) {
          // Nothing to check against. Failing a save that most likely landed
          // is worse than the race it would close, so accept the id and leave
          // the reason the check was skipped in the log.
          logger.warn("Could not verify the created server's project", {
            serverName,
            projectId: latestProjectId,
            serverId: newServerId,
            error:
              verifyError instanceof Error
                ? verifyError.message
                : "Unknown error",
          });
          return ok;
        }
        // A row missing from the read-back is our own create not yet visible,
        // not someone else's server.
        const created = rows?.find((s) => s._id === newServerId);
        return created &&
          !remoteServerBelongsToProject(created, latestProjectId)
          ? workspaceTwinConflict(created)
          : ok;
      };

      // Existing-server edits from a hosted UI carry the exact authorized row
      // id. Do not consult a possibly stale name snapshot for those writes:
      // updating a different/recreated row would silently bind the edit to the
      // wrong server.
      const exactServerId =
        target?.exactServerId && target.serverId ? target.serverId : undefined;
      const existing = exactServerId
        ? {}
        : await resolveExistingServer(flatSnapshot);
      const existingServer = existing.owned;

      const transportType = config?.command ? "stdio" : "http";
      const url =
        config?.url instanceof URL ? config.url.href : config?.url || undefined;
      const envForPayload = secretOptions
        ? hasEnvSecretPatch
          ? secretOptions.env
          : undefined
        : config?.env;
      const headersForPayload = secretOptions
        ? hasHeadersSecretPatch
          ? secretOptions.headers
          : undefined
        : headers;
      const hasBearerTokenForPayload =
        headersForPayload !== undefined
          ? hasBearerAuthorizationHeader(headersForPayload)
          : getServerBearerTokenState(serverEntry);
      const storedOAuthConfig = readStoredOAuthConfig(serverName);

      const payload = {
        name: serverName,
        enabled: serverEntry.enabled ?? false,
        transportType,
        command: config?.command,
        args: config?.args,
        ...(envForPayload !== undefined ? { env: envForPayload } : {}),
        url,
        ...(headersForPayload !== undefined
          ? { headers: headersForPayload }
          : {}),
        ...(hasBearerTokenForPayload !== undefined
          ? { hasBearerToken: hasBearerTokenForPayload }
          : {}),
        timeout: config?.timeout,
        clientCapabilities: config?.clientCapabilities,
        useOAuth: serverEntry.useOAuth,
        oauthScopes: serverEntry.oauthFlowProfile?.scopes
          ? serverEntry.oauthFlowProfile.scopes.split(",").filter(Boolean)
          : undefined,
        clientId: serverEntry.oauthFlowProfile?.clientId,
        oauthResourceUrl:
          serverEntry.oauthFlowProfile?.resourceUrl ||
          storedOAuthConfig.resourceUrl,
        // Persist the debugger test-profile choices so the catalog
        // round-trip doesn't silently reset them to DCR / 2025-11-25.
        oauthProtocolMode: serverEntry.oauthProtocolMode,
        oauthProtocolVersion: serverEntry.oauthFlowProfile?.protocolVersion,
        oauthRegistrationStrategy:
          serverEntry.oauthFlowProfile?.registrationStrategy,
        ...(serverEntry.xaaAuthzIssuer !== undefined
          ? { xaaAuthzIssuer: serverEntry.xaaAuthzIssuer }
          : {}),
        ...(serverEntry.xaaAllowPathScopedIssuer !== undefined
          ? { xaaAllowPathScopedIssuer: serverEntry.xaaAllowPathScopedIssuer }
          : {}),
        ...(serverEntry.oauthAllowPathScopedIssuer !== undefined
          ? {
              oauthAllowPathScopedIssuer:
                serverEntry.oauthAllowPathScopedIssuer,
            }
          : {}),
        ...(serverEntry.useXaa !== undefined
          ? { useXaa: serverEntry.useXaa }
          : {}),
        ...(serverEntry.authServerMode !== undefined
          ? { authServerMode: serverEntry.authServerMode }
          : {}),
        ...(serverEntry.xaaSubject !== undefined
          ? { xaaSubject: serverEntry.xaaSubject }
          : {}),
        ...(serverEntry.xaaEmail !== undefined
          ? { xaaEmail: serverEntry.xaaEmail }
          : {}),
        ...(serverEntry.xaaIdentityAssertionFormat !== undefined
          ? {
              xaaIdentityAssertionFormat:
                serverEntry.xaaIdentityAssertionFormat,
            }
          : {}),
        ...(serverEntry.xaaClientAuth !== undefined
          ? { xaaClientAuth: serverEntry.xaaClientAuth }
          : {}),
        ...(serverEntry.registrationMode !== undefined
          ? { registrationMode: serverEntry.registrationMode }
          : {}),
        ...(serverEntry.authMethod !== undefined
          ? { authMethod: serverEntry.authMethod }
          : {}),
      } as const;

      try {
        const serverIdToUpdate = exactServerId ?? existingServer?._id;
        if (serverIdToUpdate) {
          const updatePayload = {
            serverId: serverIdToUpdate,
            ...payload,
            ...(hasClientSecretValue ? { clientSecret } : {}),
            ...(clearClientSecret ? { clearClientSecret: true } : {}),
            ...(clearXaaConfig ? { clearXaaConfig: true } : {}),
          };
          if (hasSecretOperation) {
            await convexUpdateServerWithClientSecret(updatePayload);
          } else {
            await convexUpdateServer(updatePayload);
          }
          return {
            ok: true,
            projectId: latestProjectId,
            serverId: serverIdToUpdate,
          };
        }

        if (existing.workspaceTwin && hasSecretOperation) {
          return workspaceTwinConflict(existing.workspaceTwin);
        }

        const createPayload = {
          projectId: latestProjectId,
          ...payload,
          ...(hasClientSecretValue ? { clientSecret } : {}),
        };
        const newId = hasSecretOperation
          ? await convexCreateServerWithClientSecret(createPayload)
          : await convexCreateServerIfMissing(createPayload);
        if (!newId) return SERVER_NOT_SAVED;
        return hasSecretOperation
          ? await confirmSecretCreateIsOurs(newId as string)
          : {
              ok: true,
              projectId: latestProjectId,
              serverId: newId as string,
            };
      } catch (primaryError) {
        const primaryErrorMessage =
          primaryError instanceof Error
            ? primaryError.message
            : "Unknown error";
        // An exact-id edit is known to target an existing row. Falling back to
        // create-if-missing can return that row's id without applying the
        // update, which makes the UI report success before Convex rehydrates
        // the old configuration. Fail closed instead.
        if (exactServerId) {
          logger.error("Failed to update exact hosted server", {
            serverName,
            serverId: exactServerId,
            error: primaryErrorMessage,
          });
          return SERVER_NOT_SAVED;
        }
        // Best-effort fallback for stale query snapshots: re-resolve the name
        // and let the second attempt pick its own write. Both failures come
        // down to the same doubt — the row this pass resolved may not be the
        // one that exists now — so neither may skip the re-resolve and jump
        // straight to a create.
        try {
          const flatRetry =
            activeProjectServersFlatRef.current ?? activeProjectServersFlat;
          const retry = await resolveExistingServer(flatRetry, {
            forceFresh: true,
          });
          const retryExisting = retry.owned;
          if (retryExisting) {
            const updatePayload = {
              serverId: retryExisting._id,
              ...payload,
              ...(hasClientSecretValue ? { clientSecret } : {}),
              ...(clearClientSecret ? { clearClientSecret: true } : {}),
              ...(clearXaaConfig ? { clearXaaConfig: true } : {}),
            };
            if (hasSecretOperation) {
              await convexUpdateServerWithClientSecret(updatePayload);
            } else {
              await convexUpdateServer(updatePayload);
            }
            return {
              ok: true,
              projectId: latestProjectId,
              serverId: retryExisting._id,
            };
          }
          // A twin can surface here even when the first resolve missed it: a
          // sibling project may have won the name concurrently, or — the
          // ordinary case for a stale snapshot — our own row is gone and a
          // sibling's row has held the name all along. Either way a second
          // create would only resolve back to it.
          if (retry.workspaceTwin && hasSecretOperation) {
            return workspaceTwinConflict(retry.workspaceTwin);
          }
          const createPayload = {
            projectId: latestProjectId,
            ...payload,
            ...(hasClientSecretValue ? { clientSecret } : {}),
          };
          const newId = hasSecretOperation
            ? await convexCreateServerWithClientSecret(createPayload)
            : await convexCreateServerIfMissing(createPayload);
          if (!newId) return SERVER_NOT_SAVED;
          return hasSecretOperation
            ? await confirmSecretCreateIsOurs(newId as string)
            : {
                ok: true,
                projectId: latestProjectId,
                serverId: newId as string,
              };
        } catch (fallbackError) {
          logger.error("Failed to sync server to Convex", {
            serverName,
            primaryError: primaryErrorMessage,
            fallbackError:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Unknown error",
          });
          return SERVER_NOT_SAVED;
        }
      }
    },
    [
      activeProjectServersFlat,
      convex,
      convexCreateServerIfMissing,
      convexUpdateServer,
      convexCreateServerWithClientSecret,
      convexUpdateServerWithClientSecret,
      logger,
    ]
  );

  const persistRuntimeServerToProjectIfNeeded = useCallback(
    async (
      serverName: string,
      runtimeServerOverride?: ServerWithName
    ): Promise<PersistRuntimeServerResult> => {
      if (HOSTED_MODE) {
        return "noop";
      }
      const resolveRuntime = (): ServerWithName | undefined =>
        runtimeServerOverride ?? appStateServersRef.current[serverName];

      let runtime = resolveRuntime();
      if (!runtime) {
        return "noop";
      }
      if (runtime.connectionStatus !== "connected") {
        return "noop";
      }

      const initialProjectKey =
        effectiveActiveProjectIdRef.current ?? effectiveActiveProjectId;
      const frozenProjectId =
        initialProjectKey && initialProjectKey !== "none"
          ? initialProjectKey
          : null;
      let dedupeKey = `${frozenProjectId ?? "pending"}:${serverName}`;

      if (persistRuntimeDedupeKeysRef.current.has(dedupeKey)) {
        return "pending";
      }

      persistRuntimeDedupeKeysRef.current.add(dedupeKey);

      const clearDedupeKey = () => {
        persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
      };

      const rekeyDedupe = (resolvedProjectId: string): boolean => {
        const nextKey = `${resolvedProjectId}:${serverName}`;
        if (nextKey === dedupeKey) {
          return true;
        }
        if (persistRuntimeDedupeKeysRef.current.has(nextKey)) {
          persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
          return false;
        }
        persistRuntimeDedupeKeysRef.current.delete(dedupeKey);
        persistRuntimeDedupeKeysRef.current.add(nextKey);
        dedupeKey = nextKey;
        return true;
      };

      let projectId: string | null = null;
      try {
        const readyStarted = Date.now();
        while (Date.now() - readyStarted < PROJECT_SERVERS_SNAPSHOT_WAIT_MS) {
          if (isAuthLoadingRef.current || isLoadingProjectsRef.current) {
            await sleep(PROJECT_SERVERS_POLL_MS);
            continue;
          }

          if (
            !hasSignedInUserRef.current ||
            !isAuthenticatedRef.current ||
            useLocalFallbackRef.current
          ) {
            clearDedupeKey();
            return "noop";
          }

          const latestProjectId = effectiveActiveProjectIdRef.current;
          if (latestProjectId && latestProjectId !== "none") {
            if (frozenProjectId && latestProjectId !== frozenProjectId) {
              clearDedupeKey();
              return "noop";
            }
            if (!rekeyDedupe(latestProjectId)) {
              return "pending";
            }
            projectId = latestProjectId;
            break;
          }

          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        if (!projectId) {
          if (
            !hasSignedInUserRef.current ||
            !isAuthenticatedRef.current ||
            useLocalFallbackRef.current
          ) {
            clearDedupeKey();
            return "noop";
          }
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: auth/project state did not become ready in time; skipping Convex write",
            { serverName }
          );
          clearDedupeKey();
          return "skipped_project_servers_unresolved";
        }

        const startedWait = Date.now();
        while (Date.now() - startedWait < PROJECT_SERVERS_SNAPSHOT_WAIT_MS) {
          const flat = activeProjectServersFlatRef.current;
          if (flat !== undefined) {
            break;
          }
          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        const flatAfterWait = activeProjectServersFlatRef.current;
        if (flatAfterWait === undefined) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: project server snapshot still unresolved; skipping Convex write",
            { serverName, projectId }
          );
          clearDedupeKey();
          return "skipped_project_servers_unresolved";
        }

        if (
          effectiveActiveProjectIdRef.current &&
          effectiveActiveProjectIdRef.current !== projectId
        ) {
          clearDedupeKey();
          return "noop";
        }

        const liveRuntime = appStateServersRef.current[serverName];
        if (!liveRuntime || liveRuntime.connectionStatus !== "connected") {
          clearDedupeKey();
          return "noop";
        }
        runtime = liveRuntime;

        if (
          flatAfterWait.some(
            (s) =>
              s.name === serverName &&
              remoteServerBelongsToProject(s, projectId)
          )
        ) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: runtime server not persisted because a saved server with the same name already exists",
            { serverName, projectId }
          );
          clearDedupeKey();
          return "skipped_existing_name";
        }

        let convexResult: ServerSyncResult;
        try {
          convexResult = await syncServerToConvex(serverName, runtime);
        } catch (syncError) {
          logger.error(
            "persistRuntimeServerToProjectIfNeeded: syncServerToConvex threw",
            {
              serverName,
              projectId,
              phase: "syncServerToConvex",
              error:
                syncError instanceof Error
                  ? syncError.message
                  : "Unknown error",
            }
          );
          clearDedupeKey();
          return "failed";
        }

        if (!convexResult.ok) {
          logger.error(
            "persistRuntimeServerToProjectIfNeeded: syncServerToConvex returned no server id",
            {
              serverName,
              projectId,
              phase: "after_syncServerToConvex",
              reason: convexResult.reason,
            }
          );
          clearDedupeKey();
          return "failed";
        }

        const echoStarted = Date.now();
        let echoed = false;
        while (Date.now() - echoStarted < PROJECT_SERVER_ECHO_WAIT_MS) {
          const flatEcho = activeProjectServersFlatRef.current;
          if (
            flatEcho?.some(
              (s) =>
                s.name === serverName &&
                remoteServerBelongsToProject(s, projectId)
            )
          ) {
            echoed = true;
            break;
          }
          await sleep(PROJECT_SERVERS_POLL_MS);
        }

        if (!echoed) {
          logger.warn(
            "persistRuntimeServerToProjectIfNeeded: timed out waiting for project server echo after persist",
            { serverName, projectId }
          );
        }

        clearDedupeKey();
        return "persisted";
      } catch (unexpected) {
        logger.error(
          "persistRuntimeServerToProjectIfNeeded: unexpected error",
          {
            serverName,
            projectId,
            error:
              unexpected instanceof Error
                ? unexpected.message
                : "Unknown error",
          }
        );
        clearDedupeKey();
        return "failed";
      }
    },
    [effectiveActiveProjectId, syncServerToConvex, logger]
  );

  /**
   * Resolve selected runtime server names → persisted Convex server ids for a
   * HOSTED send, persisting any ad-hoc/App server that isn't saved yet. The
   * hosted harness proxy + `authorize-batch` operate on real `Id<'servers'>`, so
   * a display name like "Excalidraw (App)" must become a Convex id before the
   * send (otherwise the mint endpoint 422s and the turn fails closed). Mirrors
   * the manual-connect persist path (`syncServerToConvex` → inject mapping).
   * THROWS if a name can't be resolved/persisted — the caller must fail the send
   * closed rather than send a name.
   */
  const ensureHostedServerIdsForNames = useCallback(
    async (
      serverNames: string[]
    ): Promise<Array<{ serverName: string; serverId: string }>> => {
      const out: Array<{ serverName: string; serverId: string }> = [];
      for (const serverName of serverNames) {
        const resolved = tryResolveProjectServer(serverName);
        if (resolved?.serverId) {
          out.push({ serverName, serverId: resolved.serverId });
          continue;
        }
        const entry = appStateServersRef.current[serverName];
        if (!entry) {
          throw new Error(
            `Cannot start: server "${serverName}" is not connected, so it can't be saved to the project.`
          );
        }
        const synced = await syncServerToConvex(serverName, entry);
        if (!synced.ok) {
          throw new Error(
            synced.reason === "workspace-name-taken"
              ? `Cannot start: a server named "${serverName}" already exists in this workspace. Choose a different name.`
              : `Cannot start: failed to save server "${serverName}" to the project.`
          );
        }
        injectHostedServerMapping(serverName, synced.serverId);
        out.push({ serverName, serverId: synced.serverId });
      }
      return out;
    },
    [syncServerToConvex]
  );

  const removeServerFromConvex = useCallback(
    async (serverName: string) => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveProjectId) {
        return;
      }

      const existingServer = activeProjectServersFlat?.find(
        (s) => s.name === serverName
      );

      if (!existingServer) {
        logger.warn("Server not found in Convex for deletion", { serverName });
        return;
      }

      try {
        await convexDeleteServer({
          serverId: existingServer._id,
        });
      } catch (error) {
        logger.error("Failed to remove server from Convex", {
          serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [
      useLocalFallback,
      isAuthenticated,
      effectiveActiveProjectId,
      activeProjectServersFlat,
      convexDeleteServer,
      logger,
    ]
  );

  const persistServerToLocalProject = useCallback(
    (
      serverName: string,
      serverEntry: ServerWithName,
      options?: { originalServerName?: string }
    ) => {
      const targetProjectId =
        effectiveActiveProjectId !== "none"
          ? effectiveActiveProjectId
          : appState.activeProjectId;

      if (!targetProjectId || targetProjectId === "none") {
        return;
      }

      const project =
        effectiveProjects[targetProjectId] ??
        appState.projects[targetProjectId];
      if (!project) {
        return;
      }

      const nextServers = { ...project.servers };
      if (
        options?.originalServerName &&
        options.originalServerName !== serverName
      ) {
        delete nextServers[options.originalServerName];
      }
      nextServers[serverName] = serverEntry;

      dispatch({
        type: "UPDATE_PROJECT",
        projectId: targetProjectId,
        updates: { servers: nextServers },
      });
    },
    [
      effectiveActiveProjectId,
      effectiveProjects,
      appState.activeProjectId,
      appState.projects,
      dispatch,
    ]
  );

  const fetchAndStoreInitInfo = useCallback(
    async (serverName: string) => {
      try {
        const result = await getInitializationInfo(serverName);
        if (result.success && result.initInfo) {
          dispatch({
            type: "SET_INITIALIZATION_INFO",
            name: serverName,
            initInfo: result.initInfo,
          });
        }
      } catch (error) {
        console.debug("Failed to fetch initialization info", {
          serverName,
          error,
        });
      }
    },
    [dispatch]
  );

  /**
   * Stores init info from an inline connection result, or falls back to
   * fetching it via a separate request. Callers can fire-and-forget (no await)
   * or await depending on whether they need it resolved before continuing.
   */
  const storeInitInfo = useCallback(
    async (
      serverName: string,
      initInfo: Record<string, unknown> | null | undefined
    ) => {
      if (initInfo) {
        dispatch({
          type: "SET_INITIALIZATION_INFO",
          name: serverName,
          initInfo,
        });
      } else {
        await fetchAndStoreInitInfo(serverName);
      }
    },
    [dispatch, fetchAndStoreInitInfo]
  );

  // Re-validate already-connected servers when the resolved effective
  // `mcpProtocolVersion` for them changes — either because the host-level
  // default flipped or a per-server override moved. The pinned wire mode
  // is part of every subsequent request payload (via
  // `buildResolverConnectionDefaults`), so a server that no longer speaks
  // the pinned version will fail every call after the switch; without this
  // re-test the durable "Connected" pill keeps lying until the user manually
  // toggles the server.
  //
  // Behavior:
  // - On the first observation of a connected server, seed the last-applied
  //   map without re-testing (so steady-state mounts don't trigger probes).
  // - On a subsequent observation where the resolved version differs, kick
  //   off `guardedReconnectServer` (which threads the new pin through
  //   `buildResolverConnectionDefaults` / `withProjectConnectionDefaults`).
  //   Dispatch `CONNECT_SUCCESS` or `CONNECT_FAILURE` based on the result so
  //   the toggle reflects reality.
  // - Race protection via the existing `nextOpToken` / `isStaleOp` pattern,
  //   so a user-initiated disconnect or another pin change supersedes an
  //   in-flight re-test.
  // - Drop entries for servers no longer in "connected" status so a manual
  //   reconnect re-seeds against the live pin rather than against whatever
  //   was last seen.
  const lastAppliedProtocolVersionRef = useRef<
    Map<string, McpProtocolVersion | undefined>
  >(new Map());
  useEffect(() => {
    const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
    const hostPin: McpProtocolVersion | undefined =
      typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
        ? rawHostPin
        : undefined;

    const observed = new Set<string>();
    for (const [name, server] of Object.entries(appState.servers)) {
      if (server.connectionStatus !== "connected") continue;
      observed.add(name);

      const resolved = tryResolveProjectServer(name);
      const serverId = resolved?.serverId;
      const rawOverride =
        serverId && activeHostConfig
          ? activeHostConfig.serverConnectionOverrides?.[serverId]
              ?.mcpProtocolVersionOverride
          : undefined;
      const serverOverride: McpProtocolVersion | undefined =
        typeof rawOverride === "string" && isKnownProtocolVersion(rawOverride)
          ? rawOverride
          : undefined;
      // Same precedence as the connect resolver (shared helper) so the
      // "did the effective version change?" decision matches what we would
      // actually connect with — including the config pin and the 2026 era
      // implied by the server's OAuth profile, not just override/host default.
      const effective = resolveEffectiveWireProtocolVersion({
        serverConfig: server.config,
        server,
        serverOverride,
        hostPin,
      });

      const seenBefore = lastAppliedProtocolVersionRef.current.has(name);
      const previous = lastAppliedProtocolVersionRef.current.get(name);
      lastAppliedProtocolVersionRef.current.set(name, effective);

      // Initial observation seeds without probing.
      if (!seenBefore) continue;
      if (previous === effective) continue;

      // Resolved pin changed for a connected server. Re-test asynchronously;
      // dispatch CONNECT_FAILURE if the server can't speak the new wire mode
      // (e.g. legacy 2025 server with the host now pinned to a draft).
      const serverConfig = server.config;
      const useOAuth = server.useOAuth ?? false;
      const token = nextOpToken(name);
      void (async () => {
        try {
          const result = await guardedReconnectServer(name, serverConfig, {
            attempt: "protocol_revalidation",
          });
          if (isStaleOp(name, token)) return;
          if (result?.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name,
              config: serverConfig,
              tokens: undefined,
              useOAuth,
            });
            if (result.initInfo) {
              await storeInitInfo(name, result.initInfo).catch(() => {});
            }
            return;
          }
          const errorMessage =
            (typeof result?.error === "string" && result.error.length > 0
              ? result.error
              : undefined) ??
            `Server does not speak the pinned MCP protocol version (${
              effective ?? "default"
            })`;
          // Thread backend-attached normalized so the reducer doesn't
          // re-derive a less-specific slug from just the message string.
          const reTestNormalized = (result as { normalized?: unknown })
            ?.normalized;
          dispatch({
            type: "CONNECT_FAILURE",
            name,
            error: errorMessage,
            ...(reTestNormalized && typeof reTestNormalized === "object"
              ? { normalized: reTestNormalized as NormalizedError }
              : {}),
          });
        } catch (error) {
          if (isStaleOp(name, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name,
            error:
              error instanceof Error
                ? error.message
                : "Connection re-test failed after protocol version change",
          });
        }
      })();
    }

    // Drop entries for servers no longer in "connected" status so the next
    // manual connect re-seeds against the current pin.
    for (const name of Array.from(
      lastAppliedProtocolVersionRef.current.keys()
    )) {
      if (!observed.has(name)) {
        lastAppliedProtocolVersionRef.current.delete(name);
      }
    }
  }, [
    appState.servers,
    activeMcpProfile?.mcpProtocolVersion,
    activeHostConfig,
    dispatch,
    guardedReconnectServer,
    storeInitInfo,
  ]);

  const testConnectionAfterOAuth = useCallback(
    async (serverConfig: MCPServerConfig, serverName: string) => {
      try {
        const firstResult = await guardedTestConnection(
          serverConfig,
          serverName
        );
        if (
          firstResult.success ||
          !shouldRetryOAuthConnectionFailure(firstResult.error)
        ) {
          return firstResult;
        }

        logger.warn(
          "Retrying OAuth connection after transient transport error",
          {
            serverName,
            error: firstResult.error,
          }
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown connection error";
        if (!shouldRetryOAuthConnectionFailure(errorMessage)) {
          throw error;
        }

        logger.warn("Retrying OAuth connection after transport exception", {
          serverName,
          error: errorMessage,
        });
      }

      await delay(OAUTH_CONNECTION_RETRY_DELAY_MS);
      return guardedTestConnection(serverConfig, serverName);
    },
    [guardedTestConnection, logger]
  );

  const resolveOAuthInitiationInputs = useCallback(
    async (
      formData: ServerFormData
    ): Promise<ResolvedOAuthInitiationInputs> => {
      let registryOAuthConfig: RegistryOAuthConfigResponse | null = null;

      if (formData.registryServerId) {
        try {
          registryOAuthConfig = (await convex.query(
            "registryServers:getRegistryServerOAuthConfig" as any,
            { registryServerId: formData.registryServerId } as any
          )) as RegistryOAuthConfigResponse | null;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          throw new Error(
            `Failed to resolve registry OAuth config: ${errorMessage}`
          );
        }
      }

      const clientId =
        typeof registryOAuthConfig?.clientId === "string" &&
        registryOAuthConfig.clientId.trim() !== ""
          ? registryOAuthConfig.clientId
          : formData.clientId;
      const scopes =
        Array.isArray(registryOAuthConfig?.scopes) &&
        registryOAuthConfig.scopes.every(
          (scope): scope is string => typeof scope === "string"
        )
          ? registryOAuthConfig.scopes
          : formData.oauthScopes;

      return {
        clientId,
        clientSecret: formData.clientSecret,
        hasClientSecret: Boolean(
          formData.clientSecret || formData.hasClientSecret
        ),
        registryServerId: formData.registryServerId,
        scopes,
        useRegistryOAuthProxy: Boolean(clientId && formData.registryServerId),
      };
    },
    [convex]
  );

  const handleOAuthCallbackComplete = useCallback(
    async (
      code: string,
      state: string | null,
      iss: string | null,
      hostedCallbackContext: ReturnType<typeof getHostedOAuthCallbackContext>
    ) => {
      const pendingServerName = localStorage.getItem(OAUTH_PENDING_STORAGE_KEY);
      const isHostedProjectCallback =
        HOSTED_MODE &&
        isAuthenticated &&
        hostedCallbackContext?.surface === "project";
      const handleLiveOAuthTrace = (oauthTrace: OAuthTrace) => {
        const traceServerName =
          oauthTrace.serverName ??
          hostedCallbackContext?.serverName ??
          pendingServerName ??
          null;
        if (traceServerName) {
          updateServerOAuthTrace(traceServerName, oauthTrace);
        }
      };

      try {
        const result = isHostedProjectCallback
          ? await completeHostedOAuthCallback(hostedCallbackContext, code, {
              callbackState: state,
              callbackIss: iss,
              onTraceUpdate: handleLiveOAuthTrace,
            })
          : await handleOAuthCallback(code, {
              onTraceUpdate: handleLiveOAuthTrace,
              callbackState: state,
              callbackIss: iss,
            });

        localStorage.removeItem("mcp-oauth-return-hash");
        if (hostedCallbackContext) {
          // The pending marker is written for local-mode project flows too —
          // clear it whenever a marker-backed callback settles, not only on
          // the hosted completion path.
          clearHostedOAuthPendingState();
        }
        if (result.success) {
          localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY);
        }

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;
          // Prefer the runtime entry over the project catalog: it holds the
          // user's freshly-saved OAuth config (clientId/secret/scopes/issuer),
          // which the catalog round-trip can lag or drop. Rebuilding from the
          // catalog here — then syncing back — is what reset the config after a
          // reconnect that needed re-auth.
          const existingServer =
            appStateServersRef.current[serverName] ??
            latestEffectiveServersRef.current[serverName];
          const mergedServerConfig = mergeOAuthCallbackServerConfig(
            existingServer?.config,
            result.serverConfig
          );
          const storedOAuthConfig = readStoredOAuthConfig(serverName);
          const storedClientCredentials =
            readStoredClientCredentials(serverName);
          const resolvedOAuthProfile = buildResolvedOAuthProfile({
            serverName,
            serverUrl: String(mergedServerConfig.url),
            existingProfile: existingServer?.oauthFlowProfile,
            storedOAuthConfig,
            storedClientCredentials,
            oauthResourceUrl: result.oauthResourceUrl,
          });
          const oauthServerEntry: ServerWithName = {
            ...(existingServer ?? {}),
            name: serverName,
            config: mergedServerConfig,
            lastConnectionTime:
              existingServer?.lastConnectionTime ?? new Date(),
            connectionStatus:
              existingServer?.connectionStatus ?? "disconnected",
            retryCount: existingServer?.retryCount ?? 0,
            enabled: existingServer?.enabled ?? true,
            oauthTokens: existingServer?.oauthTokens,
            oauthFlowProfile: resolvedOAuthProfile,
            hasClientSecret: existingServer?.hasClientSecret,
            xaaAuthzIssuer: existingServer?.xaaAuthzIssuer,
            xaaAllowPathScopedIssuer: existingServer?.xaaAllowPathScopedIssuer,
            oauthAllowPathScopedIssuer:
              existingServer?.oauthAllowPathScopedIssuer,
            initializationInfo: existingServer?.initializationInfo,
            useOAuth: true,
            oauthProtocolMode:
              existingServer?.oauthProtocolMode ??
              storedOAuthConfig.protocolMode ??
              resolvedOAuthProfile?.protocolVersion ??
              "2025-11-25",
            lastOAuthTrace: result.oauthTrace,
          };

          dispatch({
            type: "UPSERT_SERVER",
            name: serverName,
            server: oauthServerEntry,
          });
          if (!isAuthenticated || useLocalFallback) {
            persistServerToLocalProject(serverName, oauthServerEntry);
          } else {
            // Sync against the project/server the OAuth flow was pinned to
            // when the redirect started, not the ambient active project. The
            // active organization can resolve to the fallback org (first
            // owned org) during the post-callback remount, and syncing by
            // name against that org's project used to create an
            // unauthenticated duplicate of the server there. The pin applies
            // to hosted AND legacy (local-mode) completions — both funnel
            // into this same Convex sync.
            const pinnedTarget = hostedCallbackContext?.projectId
              ? {
                  projectId: hostedCallbackContext.projectId,
                  serverId: hostedCallbackContext.serverId ?? null,
                }
              : undefined;
            // Fire-and-forget, so a refusal has to be inspected: it resolves
            // rather than rejecting, and the OAuth profile silently never
            // reaches Convex. Warn on both, and tell the user about the one
            // they can act on — a taken name will refuse every retry.
            syncServerToConvex(
              serverName,
              oauthServerEntry,
              undefined,
              pinnedTarget
            )
              .then((synced) => {
                if (synced.ok) return;
                logger.warn("OAuth profile was not saved to Convex", {
                  serverName,
                  reason: synced.reason,
                });
                if (synced.reason === "workspace-name-taken") {
                  toast.error(
                    `Signed in, but "${serverName}" could not be saved: that name already belongs to another project in this workspace.`
                  );
                }
              })
              .catch((error) =>
                logger.warn("Failed to sync OAuth profile to Convex", {
                  serverName,
                  error,
                })
              );
          }

          // A conformance problem that did not block the OAuth flow (today: an
          // RFC 9207 `iss` mismatch on a version that does not mandate the
          // check). Surfaced here, on the successful OAuth completion, rather
          // than alongside the connection result: the MCP connection test that
          // follows can fail for entirely unrelated reasons, and the mismatch
          // must not disappear behind that error. The trace step alone lives in
          // the OAuth logs panel, which nobody is looking at while connecting.
          if (result.warning) {
            logger.warn("OAuth conformance warning", {
              serverName,
              warning: result.warning,
            });
            toast.warning(result.warning);
          }

          dispatch({
            type: "CONNECT_REQUEST",
            name: serverName,
            config: mergedServerConfig,
            select: true,
          });

          try {
            const connectionResult = await testConnectionAfterOAuth(
              withProjectConnectionDefaults(mergedServerConfig),
              serverName
            );
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: serverName,
                config: mergedServerConfig,
                tokens: undefined,
                useOAuth: true,
                oauthTrace: result.oauthTrace,
              });
              logger.info("OAuth connection successful", { serverName });
              markPendingChatScopeStepUpReady(serverName);
              markPendingDirectScopeStepUpReplayReady(serverName);
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`
              );
              storeInitInfo(serverName, connectionResult.initInfo).catch(
                (err) =>
                  logger.warn("Failed to fetch init info", {
                    serverName,
                    err,
                  })
              );
            } else {
              markPendingChatScopeStepUpCancelled(
                serverName,
                connectionResult.error ||
                  "The server could not reconnect after authorization."
              );
              cancelPendingDirectScopeStepUpReplay(serverName);
              dispatch({
                type: "CONNECT_FAILURE",
                name: serverName,
                error:
                  connectionResult.error ||
                  "Connection test failed after OAuth",
                normalized: (connectionResult as { normalized?: unknown })
                  .normalized as any,
                oauthTrace: result.oauthTrace,
              });
              logger.error("OAuth connection test failed", {
                serverName,
                error: connectionResult.error,
              });
              toast.error(
                `OAuth succeeded but connection test failed: ${connectionResult.error}`
              );
            }
          } catch (connectionError) {
            markPendingChatScopeStepUpCancelled(
              serverName,
              "The server could not reconnect after authorization."
            );
            cancelPendingDirectScopeStepUpReplay(serverName);
            const errorMessage =
              connectionError instanceof Error
                ? connectionError.message
                : "Unknown connection error";
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
              oauthTrace: result.oauthTrace,
            });
            logger.error("OAuth connection test error", {
              serverName,
              error: errorMessage,
            });
            toast.error(
              `OAuth succeeded but connection test failed: ${errorMessage}`
            );
          }
        } else {
          throw {
            message: result.error || "OAuth callback failed",
            oauthTrace: result.oauthTrace,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : "Unknown error";
        toast.error(`Error completing OAuth flow: ${errorMessage}`);
        logger.error("OAuth callback failed", { error: errorMessage });
        const oauthTrace =
          typeof error === "object" && error !== null && "oauthTrace" in error
            ? (error as { oauthTrace?: OAuthTrace }).oauthTrace
            : undefined;
        const failedServerName =
          failPendingOAuthConnection(errorMessage, oauthTrace) ??
          pendingServerName;
        if (failedServerName) {
          markPendingChatScopeStepUpCancelled(failedServerName, errorMessage);
          cancelPendingDirectScopeStepUpReplay(failedServerName);
          logger.warn("Marked pending OAuth connection as failed", {
            serverName: failedServerName,
            error: errorMessage,
          });
        }
      }
    },
    [
      dispatch,
      failPendingOAuthConnection,
      isAuthenticated,
      logger,
      persistServerToLocalProject,
      storeInitInfo,
      testConnectionAfterOAuth,
      guardedTestConnection,
      syncServerToConvex,
      updateServerOAuthTrace,
      useLocalFallback,
      withProjectConnectionDefaults,
    ]
  );

  useEffect(() => {
    if (isDebugOAuthCallbackPath(window.location.pathname)) {
      return;
    }

    if (isLoading) return;
    if (isAuthLoading) return;

    if (
      isAuthenticated &&
      !useLocalFallback &&
      (isLoadingProjects || !effectiveActiveProjectId)
    ) {
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const state = urlParams.get("state");
    const error = urlParams.get("error");
    // 2R-iss: RFC 9207 issuer identification from the callback URL.
    const iss = urlParams.get("iss");
    const errorDescription = urlParams.get("error_description");
    const electronCallbackUrl = buildElectronMcpCallbackUrl();
    // Read in local mode too: the pending marker pins the org/project/server
    // the flow started from, and the post-callback sync needs that pin
    // regardless of whether completion runs hosted (backend session) or
    // legacy (client-side token exchange).
    const hostedOAuthCallbackContext = getHostedOAuthCallbackContext();
    if (electronCallbackUrl) {
      return;
    }
    const isHostedProjectCallback =
      hostedOAuthCallbackContext?.surface === "project";
    if (code) {
      if (hostedOAuthCallbackContext && !isHostedProjectCallback) {
        return; // Handled by App.tsx hosted OAuth interception
      }
      if (oauthCallbackHandledRef.current) {
        return;
      }

      // Prefer the hostedOAuthCallbackContext server name (already validated),
      // fall back to the legacy localStorage key.
      const earlyPendingName =
        hostedOAuthCallbackContext?.serverName ??
        localStorage.getItem(OAUTH_PENDING_STORAGE_KEY);

      // A `?code=` in the URL is NOT proof the callback is ours. This effect
      // runs on every route, so any other OAuth-shaped return lands here too —
      // notably the GitHub App bind at `/settings/integrations/github/callback`,
      // which this handler used to claim, fail, toast "No pending OAuth flow
      // found", and then navigate away from, stripping GitHub's `code`/`state`
      // out of the URL before the route that owned them could read them.
      //
      // The guard is DERIVED, not a path denylist: both completion paths read
      // exactly this pending marker and throw "No pending OAuth flow found"
      // when it is absent (`mcp-oauth.ts` — `handleOAuthCallback` and
      // `completeHostedOAuthCallback`). So with no marker there is no MCP flow
      // to complete and claiming the callback could only ever have failed. A
      // path list would have to grow by hand for every future OAuth route and
      // would silently break the one nobody remembered to add.
      //
      // Deliberate consequence: a genuinely orphaned MCP callback (marker lost
      // to a cleared localStorage or another tab) no longer raises a toast. It
      // was unrecoverable either way, the message named nothing the user could
      // act on, and leaving the URL intact is more honest than navigating away
      // from a callback we cannot attribute.
      if (!earlyPendingName) {
        return;
      }

      oauthCallbackHandledRef.current = true;

      // Dispatch "connecting" immediately so SYNC_AGENT_STATUS (which fires
      // concurrently) cannot set the server back to "disconnected" while the
      // token exchange is still in flight.
      if (earlyPendingName) {
        const earlyServer = effectiveServers[earlyPendingName];
        if (earlyServer) {
          dispatch({
            type: "CONNECT_REQUEST",
            name: earlyPendingName,
            config: earlyServer.config,
            select: true,
          });
        }
      }

      // Captured before completion: handleOAuthCallbackComplete clears the
      // return-hash key as part of its cleanup.
      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";
      const restoreCallbackUrl = () => {
        // The pending marker pinned the organization the flow started in.
        // Re-apply it as the explicit selection before navigating: most
        // routes (e.g. /servers) carry no org, so restoring the path alone
        // would render it under whatever org the fallback resolution picks
        // once the marker is cleared.
        const markerOrganizationId = hostedOAuthCallbackContext?.organizationId;
        if (markerOrganizationId) {
          restoreActiveOrganizationId?.(markerOrganizationId);
        }
        // Navigate through the app router, not raw history.replaceState —
        // the router never observes replaceState, so route-derived state
        // (org-scoped routes, active tab) would go stale. The marker's
        // returnPath is the exact location the user connected from.
        const returnTarget = hostedOAuthCallbackContext?.returnPath
          ? resolveHostedOAuthReturnPath(hostedOAuthCallbackContext)
          : restorePathAfterOAuthCallback(window.location.pathname, savedHash);
        navigateApp(returnTarget, { replace: true });
      };

      // Strip the ?code from the URL only after completion settles. The
      // pending-marker org pin (use-app-state) is scoped to "callback params
      // present in the URL"; stripping eagerly killed the pin mid-completion,
      // so the active org/project flipped to the fallback organization while
      // the token exchange was still in flight.
      void handleOAuthCallbackComplete(
        code,
        state,
        iss,
        isHostedProjectCallback ? hostedOAuthCallbackContext : null
      ).finally(restoreCallbackUrl);
    } else if (error) {
      if (hostedOAuthCallbackContext && !isHostedProjectCallback) {
        return; // Handled by App.tsx hosted OAuth interception
      }
      const errorMessage = errorDescription
        ? `${error}: ${errorDescription}`
        : error;
      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";

      toast.error(`OAuth authorization failed: ${errorMessage}`);
      const failedServerName = failPendingOAuthConnection(errorMessage);
      markPendingChatScopeStepUpCancelled(
        failedServerName ?? undefined,
        errorMessage
      );
      cancelPendingDirectScopeStepUpReplay(failedServerName ?? undefined);
      logger.warn("OAuth authorization failed before callback completion", {
        serverName: failedServerName,
        error,
        errorDescription,
      });
      oauthCallbackHandledRef.current = true;
      // Denied/failed authorizations return the user to where they started
      // too: same org restore + router-aware navigation as the success path.
      const markerOrganizationId = hostedOAuthCallbackContext?.organizationId;
      if (markerOrganizationId) {
        restoreActiveOrganizationId?.(markerOrganizationId);
      }
      const returnTarget = hostedOAuthCallbackContext?.returnPath
        ? resolveHostedOAuthReturnPath(hostedOAuthCallbackContext)
        : restorePathAfterOAuthCallback(window.location.pathname, savedHash);
      navigateApp(returnTarget, { replace: true });
    }
  }, [
    isLoading,
    isAuthLoading,
    isAuthenticated,
    useLocalFallback,
    isLoadingProjects,
    effectiveActiveProjectId,
    failPendingOAuthConnection,
    handleOAuthCallbackComplete,
    restoreActiveOrganizationId,
    logger,
  ]);

  const handleConnect = useCallback(
    async (formData: ServerFormData) => {
      // Snapshot the client BEFORE the first await, not when the toast is
      // built. This connect resolves its protocol pin from whichever client is
      // previewed as it starts, then spends seconds inside
      // `syncServerToConvex` / `guardedTestConnection` — long enough for the
      // user to switch clients. Capturing at the end would name a client that
      // had nothing to do with the failure, and whose dropdown cannot fix it.
      const hostIdAtConnectStart = previewedHostIdRef.current;
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const mcpConfig = toMCPConfig(formData);
      dispatch({
        type: "CONNECT_REQUEST",
        name: formData.name,
        config: mcpConfig,
        select: true,
      });
      const token = nextOpToken(formData.name);
      let hostedServerId: string | undefined;
      let syncedConnectionTarget:
        | { projectId: string; serverId: string }
        | undefined;
      const existingServerForSave = appState.servers[formData.name];
      const formOAuthProfile = buildOAuthProfileFromFormData(
        formData,
        existingServerForSave?.oauthFlowProfile
      );
      const nextHasClientSecret =
        (formData.useOAuth || formData.useXaa) && !formData.clearClientSecret
          ? Boolean(
              formData.clientSecret ||
                formData.hasClientSecret ||
                existingServerForSave?.hasClientSecret
            )
          : false;
      const clientSecretSyncOptions = buildSecretSyncOptions(formData);

      const serverEntryForSave: ServerWithName = {
        name: formData.name,
        config: mcpConfig,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: formData.useOAuth ?? false,
        oauthProtocolMode: formData.useOAuth
          ? formData.oauthProtocolMode ?? "auto"
          : undefined,
        oauthFlowProfile: formOAuthProfile,
        hasClientSecret: nextHasClientSecret,
        hasEnv:
          formData.secretPatch?.env !== undefined
            ? Object.keys(formData.secretPatch.env).length > 0
            : existingServerForSave?.hasEnv,
        hasHeaders:
          formData.secretPatch?.headers !== undefined
            ? Object.keys(formData.secretPatch.headers).length > 0
            : existingServerForSave?.hasHeaders,
        hasBearerToken:
          formData.secretPatch?.headers !== undefined
            ? hasBearerAuthorizationHeader(formData.secretPatch.headers)
            : getServerBearerTokenState(existingServerForSave),
        xaaAuthzIssuer:
          formData.xaaAuthzIssuer ?? existingServerForSave?.xaaAuthzIssuer,
        xaaAllowPathScopedIssuer:
          formData.xaaAllowPathScopedIssuer ??
          existingServerForSave?.xaaAllowPathScopedIssuer,
        oauthAllowPathScopedIssuer:
          formData.oauthAllowPathScopedIssuer ??
          existingServerForSave?.oauthAllowPathScopedIssuer,
        useXaa: formData.useXaa ?? false,
        // Shared atomic identity-pair semantics (omitted pair preserves the
        // stored values, explicit "" pair clears) + authServerMode default.
        ...resolveXaaIdentitySaveFields({
          useXaa: formData.useXaa === true,
          formAuthServerMode: formData.authServerMode,
          formSubject: formData.xaaSubject,
          formEmail: formData.xaaEmail,
          existing: existingServerForSave,
        }),
        // Unified fields: preserve any saved value when a save that omits
        // them comes through, rather than erasing it.
        xaaIdentityAssertionFormat:
          formData.xaaIdentityAssertionFormat ??
          existingServerForSave?.xaaIdentityAssertionFormat,
        xaaClientAuth:
          formData.xaaClientAuth ?? existingServerForSave?.xaaClientAuth,
        registrationMode:
          formData.registrationMode ?? existingServerForSave?.registrationMode,
        authMethod: formData.authMethod ?? existingServerForSave?.authMethod,
      };
      // Both modes: await Convex sync so the returned serverId is available
      // for OAuth binding (hosted) and for the new {projectId, serverId}
      // request shape (local mode resolver path). Failure is non-fatal in
      // local mode — the legacy {serverConfig, serverId: name} body still
      // works as a fallback.
      let syncErr: unknown;
      let workspaceNameTaken = false;
      try {
        const synced = await syncServerToConvex(
          formData.name,
          serverEntryForSave,
          clientSecretSyncOptions
        );
        if (synced.ok) {
          hostedServerId = synced.serverId;
          syncedConnectionTarget = {
            projectId: synced.projectId,
            serverId: synced.serverId,
          };
          injectHostedServerMapping(formData.name, synced.serverId);
        } else {
          workspaceNameTaken = synced.reason === "workspace-name-taken";
        }
      } catch (err) {
        syncErr = err;
        logger.warn("Sync to Convex failed (pre-connection)", {
          serverName: formData.name,
          err,
        });
      }
      if (
        HOSTED_MODE &&
        isAuthenticated &&
        !useLocalFallback &&
        (syncErr || !hostedServerId)
      ) {
        // Hosted project connects require a Convex server row before any
        // runtime connection starts. Continuing after a cloud save failure
        // creates an unscoped runtime-only server that can appear under another
        // organization while remaining unauthenticated.
        // A taken workspace name is the user's to fix and survives every retry,
        // so it must not arrive as "Please try again".
        const errorMessage = workspaceNameTaken
          ? `A server named "${formData.name}" already exists in this workspace. Choose a different name.`
          : syncErr instanceof Error
          ? syncErr.message
          : "Could not save the hosted server before connecting. Please try again.";
        dispatch({
          type: "CONNECT_FAILURE",
          name: formData.name,
          error: errorMessage,
        });
        toast.error(errorMessage);
        return;
      }
      if (!isAuthenticated) {
        const project = appState.projects[appState.activeProjectId];
        if (project) {
          dispatch({
            type: "UPDATE_PROJECT",
            projectId: appState.activeProjectId,
            updates: {
              servers: {
                ...project.servers,
                [formData.name]: serverEntryForSave,
              },
            },
          });
        }
      }

      // Capture provenance before saving: saveOAuthConfigToLocalStorage updates
      // the server URL first, so reading it afterward would make a stale
      // resource indicator look like it belonged to the edited endpoint.
      const storedOAuthConfigBeforeSave = readStoredOAuthConfig(formData.name);
      const storedServerUrlBeforeSave = HOSTED_MODE
        ? undefined
        : localStorage.getItem(`mcp-serverUrl-${formData.name}`) ?? undefined;
      saveOAuthConfigToLocalStorage(formData);

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          // Keyed by project + server id so identically named servers across
          // projects don't share escalation state; name is the last-resort
          // key for servers that haven't synced an id yet.
          const escalationIdentity: AutoEscalationIdentity = {
            projectId: appState.activeProjectId,
            serverId: hostedServerId ?? null,
            serverName: formData.name,
          };
          // Reuse the canonical config from `toMCPConfig` (which carries the
          // 2026 `mcpProtocolVersion` stamp) rather than rebuilding a URL-only
          // config that drops the wire era — otherwise this first stored-cred
          // probe runs the 2025 initialize handshake against a sessionless
          // server and fails before OAuth can start.
          const serverConfig: MCPServerConfig = mcpConfig;
          logger.info("Connecting with synced OAuth credentials", {
            serverName: formData.name,
          });
          const storedCredentialResult = await guardedTestConnection(
            withProjectConnectionDefaults(serverConfig),
            formData.name,
            serverEntryForSave,
            syncedConnectionTarget
          );
          if (isStaleOp(formData.name, token)) return;
          if (storedCredentialResult.success) {
            autoOAuthEscalation.markSucceeded(escalationIdentity);
            dispatch({
              type: "CONNECT_SUCCESS",
              name: formData.name,
              config: serverConfig,
              tokens: undefined,
              useOAuth: true,
              oauthFlowProfile: serverEntryForSave.oauthFlowProfile,
            });
            // An Auto server may have connected without credentials — don't
            // claim OAuth happened when it didn't.
            toast.success(
              formData.authMethod === "auto"
                ? "Connected successfully!"
                : "Connected successfully with OAuth!"
            );
            storeInitInfo(formData.name, storedCredentialResult.initInfo).catch(
              (err) =>
                logger.warn("Failed to fetch init info", {
                  serverName: formData.name,
                  err,
                })
            );
            return;
          }
          if (!connectFailureRequiresOAuth(storedCredentialResult)) {
            const errorMessage =
              storedCredentialResult.error || "OAuth connection failed";
            dispatch({
              type: "CONNECT_FAILURE",
              name: formData.name,
              error: errorMessage,
              normalized: (storedCredentialResult as { normalized?: unknown })
                .normalized as any,
            });
            toast.error(errorMessage);
            return;
          }
          // Auto escalation gate: the user picked Auto, not OAuth, so a 401
          // asks before redirecting. A still-pending marker means a confirmed
          // flow already ran and the server 401'd again — surface the config
          // problem (and clear, so a later manual attempt re-prompts) instead
          // of looping.
          if (formData.authMethod === "auto") {
            const failWithoutEscalation = (message: string) => {
              dispatch({
                type: "CONNECT_FAILURE",
                name: formData.name,
                error: message,
                normalized: (storedCredentialResult as { normalized?: unknown })
                  .normalized as any,
              });
            };
            if (autoOAuthEscalation.hasPendingAttempt(escalationIdentity)) {
              autoOAuthEscalation.markFailed(escalationIdentity);
              const errorMessage = `Server "${formData.name}" still returns 401 after OAuth. Check the server's authorization configuration.`;
              failWithoutEscalation(errorMessage);
              toast.error(errorMessage);
              return;
            }
            const proceed = await confirmAutoOAuthEscalation(formData.name);
            if (isStaleOp(formData.name, token)) return;
            if (!proceed) {
              failWithoutEscalation(
                `Server "${formData.name}" requires authorization. Reconnect to sign in with OAuth.`
              );
              return;
            }
            autoOAuthEscalation.markPending(escalationIdentity);
          }
          logger.info("Synced OAuth credentials require a fresh OAuth flow", {
            serverName: formData.name,
            error: storedCredentialResult.error,
          });

          dispatch({
            type: "UPSERT_SERVER",
            name: formData.name,
            server: {
              ...serverEntryForSave,
              connectionStatus: "oauth-flow",
              enabled: true,
              useOAuth: true,
            } as ServerWithName,
          });

          const oauthInputs = await resolveOAuthInitiationInputs(formData);
          const existingServer = appState.servers[formData.name];
          const existingOAuthProfile = existingServer?.oauthFlowProfile;
          const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
          const hostPin =
            typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
              ? rawHostPin
              : undefined;
          const effectiveWireProtocolVersion =
            resolveEffectiveWireProtocolVersion({
              serverConfig: mcpConfig,
              server: existingServer,
              serverOverride: formData.mcpProtocolVersionOverride,
              hostPin,
            });
          const protocolSelection = resolveOAuthProtocolSelection({
            mode:
              formData.oauthProtocolMode ?? existingServer?.oauthProtocolMode,
            legacyProtocolVersion: existingOAuthProfile?.protocolVersion,
            wireProtocolVersion: effectiveWireProtocolVersion,
            // This connect attempt was stopped by 401, so an older server
            // card's initializationInfo is not fresh evidence for this flow.
            negotiatedProtocolVersion: undefined,
          });
          const registrationMode =
            formData.registrationMode ??
            existingOAuthProfile?.registrationStrategy ??
            "auto";
          // The builder refuses a configured resource indicator that is not
          // this server's, BEFORE the redirect. Handle it here as the sibling
          // entry points do: without a local catch it falls to the outer
          // handler and is reported as "Network error: …", which is the one
          // label it definitely is not. The escalation marker has to be
          // cleared too — `markPending` already ran above, and leaving it set
          // makes the next 401 read as a completed-but-failed OAuth attempt
          // and refuse to offer authorization at all.
          let oauthOptions: BuiltOAuthRequest;
          try {
            oauthOptions = buildOAuthRequest(
              {
                serverName: formData.name,
                serverUrl: formData.url,
                scopes: oauthInputs.scopes,
                // Previously omitted here while every other entry point sent it,
                // so a server with a configured resource indicator authorized
                // against a different audience on first connect than on
                // reconnect. Both candidates are gated on still belonging to
                // THIS url — editing a server's endpoint must not carry the old
                // endpoint's audience forward.
                resourceUrl: selectStoredResourceUrl(formData.url, [
                  {
                    resourceUrl: existingOAuthProfile?.resourceUrl,
                    capturedForServerUrl: existingOAuthProfile?.serverUrl,
                  },
                  {
                    resourceUrl: storedOAuthConfigBeforeSave.resourceUrl,
                    capturedForServerUrl: storedServerUrlBeforeSave,
                  },
                ]),
                clientId: oauthInputs.clientId,
                clientSecret: oauthInputs.clientSecret,
                hasClientSecret: oauthInputs.hasClientSecret,
                registryServerId: oauthInputs.registryServerId,
                useRegistryOAuthProxy: oauthInputs.useRegistryOAuthProxy,
                customHeaders: mergeWithProjectHeaders(formData.headers),
                // Same per-server opt-in the OAuth Debugger honors: Connect runs
                // the same state machine, so without this a path-scoped
                // authorization server is rejected here even with the toggle on.
                allowPathScopedIssuer:
                  (formData.oauthAllowPathScopedIssuer ??
                    existingServer?.oauthAllowPathScopedIssuer) === true,
                protocolMode: protocolSelection.mode,
                registrationMode,
                protocolVersion: protocolSelection.protocolVersion,
                protocolResolutionSource: protocolSelection.source,
                registrationStrategy:
                  existingOAuthProfile?.registrationStrategy,
                onTraceUpdate: (oauthTrace: OAuthTrace) => {
                  updateServerOAuthTrace(formData.name, oauthTrace);
                },
              },
              { intent: "connect" }
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Failed to build the OAuth request";
            autoOAuthEscalation.markFailed(escalationIdentity);
            dispatch({
              type: "CONNECT_FAILURE",
              name: formData.name,
              error: errorMessage,
            });
            toast.error(errorMessage);
            return;
          }
          prepareHostedProjectOAuthRedirect({
            serverId: hostedServerId,
            serverName: formData.name,
            serverUrl: formData.url,
          });
          const oauthResult = await initiateOAuth(oauthOptions);
          if (oauthResult.success) {
            if (oauthResult.serverConfig) {
              const oauthServerConfig = stripAuthorizationFromHttpConfig(
                oauthResult.serverConfig
              );
              const connectionResult = await guardedTestConnection(
                withProjectConnectionDefaults(oauthServerConfig),
                formData.name,
                serverEntryForSave,
                syncedConnectionTarget
              );
              if (isStaleOp(formData.name, token)) return;
              if (connectionResult.success) {
                autoOAuthEscalation.markSucceeded(escalationIdentity);
                dispatch({
                  type: "CONNECT_SUCCESS",
                  name: formData.name,
                  config: oauthServerConfig,
                  tokens: undefined,
                  useOAuth: true,
                  oauthTrace: oauthResult.oauthTrace,
                  oauthFlowProfile: serverEntryForSave.oauthFlowProfile,
                });
                toast.success("Connected successfully with OAuth!");
                storeInitInfo(formData.name, connectionResult.initInfo).catch(
                  (err) =>
                    logger.warn("Failed to fetch init info", {
                      serverName: formData.name,
                      err,
                    })
                );
              } else {
                // Terminal in this page-session: OAuth completed but the
                // connect failed. Clear the pending marker so a later manual
                // attempt re-prompts instead of being muted all session.
                autoOAuthEscalation.markFailed(escalationIdentity);
                dispatch({
                  type: "CONNECT_FAILURE",
                  name: formData.name,
                  error:
                    connectionResult.error || "OAuth connection test failed",
                  oauthTrace: oauthResult.oauthTrace,
                });
                toast.error(
                  `OAuth succeeded but connection failed: ${connectionResult.error}`
                );
              }
            } else {
              // Redirect pending — the marker stays PENDING on purpose; it's
              // what survives the page navigation so the post-callback
              // reconnect doesn't re-prompt.
              toast.success(
                "OAuth flow initiated. You will be redirected to authorize access."
              );
            }
            return;
          }

          if (isStaleOp(formData.name, token)) return;
          // OAuth init failed before any redirect — nothing is pending.
          autoOAuthEscalation.markFailed(escalationIdentity);
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: oauthResult.error || "OAuth initialization failed",
            oauthTrace: oauthResult.oauthTrace,
          });
          toast.error(`OAuth initialization failed: ${oauthResult.error}`);
          return;
        }

        const hasPendingCallback = new URLSearchParams(
          window.location.search
        ).has("code");
        if (!hasPendingCallback) {
          clearOAuthData(formData.name);
        }
        const effectiveConfig = withProjectConnectionDefaults(mcpConfig);
        const result = await guardedTestConnection(
          effectiveConfig,
          formData.name,
          serverEntryForSave,
          syncedConnectionTarget
        );
        if (isStaleOp(formData.name, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: formData.name,
            config: mcpConfig,
            useOAuth: formData.useOAuth ?? false,
            oauthFlowProfile: serverEntryForSave.oauthFlowProfile,
          });
          // Env now persists on the Convex server doc via syncServerToConvex;
          // no localStorage write needed. The resolver returns env in the
          // resolved config on subsequent connects.
          logger.info("Connection successful", { serverName: formData.name });
          if (
            !shouldSuppressExcalidrawConnectToastForOnboarding(formData.name)
          ) {
            toast.success("Connected successfully!");
          }
          storeInitInfo(formData.name, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", {
              serverName: formData.name,
              err,
            })
          );
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: result.error || "Connection test failed",
            // Thread the backend-attached rich block through. Without this
            // the reducer's auto-derive would re-classify from just the
            // message string and lose the slug the backend already pinned
            // (e.g. `transport/econnrefused` from a Node errno match).
            ...(result.normalized ? { normalized: result.normalized } : {}),
          });
          logger.error("Connection failed", {
            serverName: formData.name,
            error: result.error,
          });
          toast.error(
            `Failed to connect to ${formData.name}${
              result.error ? `: ${result.error}` : ""
            }`,
            // A pinned protocol version the server doesn't offer is the one
            // connect failure with an exact fix, and the toast is where the
            // user is actually looking when a connect fails — the server
            // card's error area carries the same action, but nobody hunts for
            // it while a toast is on screen telling them what went wrong.
            isProtocolVersionPinFailure(result.normalized, result.error)
              ? {
                  action: {
                    label: "Change protocol version",
                    // `hostIdAtConnectStart`, bound before the first await: the
                    // pin that failed was resolved from the client active
                    // THEN, and both the connect itself and the toast that
                    // follows easily outlive a client switch.
                    onClick: () => {
                      track("change_protocol_version_clicked", {
                        location: "connect_failure_toast",
                        has_host_id: Boolean(hostIdAtConnectStart),
                      });
                      navigateApp(
                        buildHostFocusTabPath(hostIdAtConnectStart, "protocol")
                      );
                    },
                  },
                }
              : // For XAA servers, offer a shortcut to the XAA Debugger so the
                // dev can step through the handshake and pinpoint the failing
                // claim (subject not provisioned, audience/issuer mismatch).
                formData.useXaa
                ? {
                    action: {
                      label: "Open XAA Debugger",
                      onClick: () => {
                        dispatch({
                          type: "SELECT_SERVER",
                          name: formData.name,
                        });
                        navigateApp(routePaths.xaaFlow);
                      },
                    },
                  }
                : undefined
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(formData.name, token)) return;
        dispatch({
          type: "CONNECT_FAILURE",
          name: formData.name,
          error: errorMessage,
        });
        logger.error("Connection failed", {
          serverName: formData.name,
          error: errorMessage,
        });
        toast.error(
          errorMessage === PROJECT_NOT_PROVISIONED_ERROR_MESSAGE
            ? errorMessage
            : `Network error: ${errorMessage}`
        );
      }
    },
    [
      dispatch,
      isAuthenticated,
      appState.servers,
      appState.projects,
      appState.activeProjectId,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      prepareHostedProjectOAuthRedirect,
      resolveOAuthInitiationInputs,
      syncServerToConvex,
      logger,
      storeInitInfo,
      guardedTestConnection,
      updateServerOAuthTrace,
      withProjectConnectionDefaults,
    ]
  );

  const saveServerConfigWithoutConnecting = useCallback(
    async (
      formData: ServerFormData,
      options?: {
        oauthProfile?: OAuthTestProfile;
        suppressToast?: boolean;
        // The name the server was saved under before this edit. Callers editing
        // an existing server must pass it: every lookup here keys off the name,
        // so without it a rename reads as a brand-new server and forks a second
        // row. Mirrors handleUpdate's originalServerName argument.
        originalServerName?: string;
        // Exact hosted row for an existing, same-name edit. The sync path must
        // update this id or fail; it must never reinterpret the edit as a
        // create when the project-server subscription is stale.
        hostedWriteTarget?: HostedServerWriteTarget;
      }
    ) => {
      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return false;
      }

      const serverName = formData.name.trim();
      if (!serverName) {
        toast.error("Server name is required");
        return false;
      }

      const originalServerName = options?.originalServerName?.trim();
      const isRename = Boolean(
        originalServerName && originalServerName !== serverName
      );
      const activeProjectServers =
        effectiveProjects[effectiveActiveProjectId]?.servers ?? {};
      if (isRename && activeProjectServers[serverName]) {
        toast.error(
          `A server named "${serverName}" already exists. Choose a different name.`
        );
        return false;
      }

      const existingServer = appState.servers[originalServerName ?? serverName];
      const mcpConfig = toMCPConfig(formData);
      const nextOAuthProfile =
        formData.useOAuth || formData.useXaa
          ? options?.oauthProfile ??
            buildOAuthProfileFromFormData(
              formData,
              existingServer?.oauthFlowProfile
            ) ??
            existingServer?.oauthFlowProfile
          : undefined;
      const nextHasClientSecret =
        (formData.useOAuth || formData.useXaa) && !formData.clearClientSecret
          ? Boolean(
              formData.clientSecret ||
                formData.hasClientSecret ||
                existingServer?.hasClientSecret
            )
          : false;

      const serverEntry: ServerWithName = {
        ...(existingServer ?? {}),
        name: serverName,
        config: mcpConfig,
        lastConnectionTime: existingServer?.lastConnectionTime ?? new Date(),
        connectionStatus: "disconnected",
        retryCount: existingServer?.retryCount ?? 0,
        enabled: existingServer?.enabled ?? false,
        oauthFlowProfile: nextOAuthProfile,
        useOAuth: formData.useOAuth ?? false,
        oauthProtocolMode: formData.useOAuth
          ? formData.oauthProtocolMode ?? existingServer?.oauthProtocolMode
          : undefined,
        hasClientSecret: nextHasClientSecret,
        hasEnv:
          formData.secretPatch?.env !== undefined
            ? Object.keys(formData.secretPatch.env).length > 0
            : existingServer?.hasEnv,
        hasHeaders:
          formData.secretPatch?.headers !== undefined
            ? Object.keys(formData.secretPatch.headers).length > 0
            : existingServer?.hasHeaders,
        hasBearerToken:
          formData.secretPatch?.headers !== undefined
            ? hasBearerAuthorizationHeader(formData.secretPatch.headers)
            : getServerBearerTokenState(existingServer),
        xaaAuthzIssuer:
          formData.xaaAuthzIssuer ?? existingServer?.xaaAuthzIssuer,
        xaaAllowPathScopedIssuer:
          formData.xaaAllowPathScopedIssuer ??
          existingServer?.xaaAllowPathScopedIssuer,
        oauthAllowPathScopedIssuer:
          formData.oauthAllowPathScopedIssuer ??
          existingServer?.oauthAllowPathScopedIssuer,
        useXaa: formData.useXaa ?? false,
        // Shared atomic identity-pair semantics (omitted pair preserves the
        // stored values, explicit "" pair clears) + authServerMode default.
        ...resolveXaaIdentitySaveFields({
          useXaa: formData.useXaa === true,
          formAuthServerMode: formData.authServerMode,
          formSubject: formData.xaaSubject,
          formEmail: formData.xaaEmail,
          existing: existingServer,
        }),
        // Unified fields: preserve any saved value when a save that omits
        // them comes through, rather than erasing it.
        xaaIdentityAssertionFormat:
          formData.xaaIdentityAssertionFormat ??
          existingServer?.xaaIdentityAssertionFormat,
        xaaClientAuth: formData.xaaClientAuth ?? existingServer?.xaaClientAuth,
        registrationMode:
          formData.registrationMode ?? existingServer?.registrationMode,
        authMethod: formData.authMethod ?? existingServer?.authMethod,
      } as ServerWithName;

      const hasPendingOAuthCallback = new URLSearchParams(
        window.location.search
      ).has("code");
      if (!formData.useOAuth && !hasPendingOAuthCallback) {
        clearOAuthData(serverName);
      }

      const hostedProjectId =
        options?.hostedWriteTarget?.projectId ?? effectiveActiveProjectId;
      const activeHostedProjectId =
        effectiveActiveProjectId && effectiveActiveProjectId !== "none"
          ? effectiveProjects[effectiveActiveProjectId]?.sharedProjectId ??
            effectiveActiveProjectId
          : null;
      // A pinned hosted write can outlive an OAuth redirect that changes the
      // ambient project. Convex still updates the pinned row, but this client
      // state only represents the ambient project, so never inject the saved
      // config into a different project's server map.
      const shouldUpdateActiveProjectState =
        !options?.hostedWriteTarget ||
        options.hostedWriteTarget.projectId === activeHostedProjectId;
      if (
        isAuthenticated &&
        !useLocalFallback &&
        hostedProjectId &&
        hostedProjectId !== "none"
      ) {
        try {
          const synced = await syncServerToConvex(
            serverName,
            serverEntry,
            {
              ...(formData.clientSecret
                ? { clientSecret: formData.clientSecret }
                : {}),
              ...(formData.clearClientSecret
                ? { clearClientSecret: true }
                : {}),
              // One-shot XAA-config reset (modal moved the server off XAA).
              ...(formData.clearXaaConfig ? { clearXaaConfig: true } : {}),
              ...(formData.secretPatch?.env !== undefined
                ? { env: formData.secretPatch.env }
                : {}),
              ...(formData.secretPatch?.headers !== undefined
                ? { headers: formData.secretPatch.headers }
                : {}),
            },
            options?.hostedWriteTarget
              ? {
                  ...options.hostedWriteTarget,
                  exactServerId: true,
                }
              : undefined
          );
          if (!synced.ok) {
            // A name the workspace has already given to another project's
            // server is the user's to fix, and no retry will clear it. Say so
            // instead of "try again", and leave it out of the error channel —
            // the sync path already warned with the project that holds it.
            if (synced.reason === "workspace-name-taken") {
              toast.error(
                `A server named "${serverName}" already exists in this workspace. Choose a different name.`
              );
              return false;
            }
            logger.error("Failed to sync server to Convex", {
              error: "Server sync returned no server id",
            });
            toast.error("Could not save the server. Please try again.");
            return false;
          }
        } catch (error) {
          logger.error("Failed to sync server to Convex", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not save the server. Please try again."
          );
          return false;
        }
      } else {
        persistServerToLocalProject(serverName, serverEntry, {
          originalServerName: isRename ? originalServerName : undefined,
        });
      }

      if (shouldUpdateActiveProjectState) {
        // Drop the old local row only once the new one is stored. An exact-ID
        // hosted rename already renamed the same Convex row, so its cleanup
        // must not issue a second name-based cloud delete against a stale
        // snapshot.
        if (isRename && originalServerName) {
          await handleRemoveServerRef.current?.(originalServerName, {
            removeFromCloud: !options?.hostedWriteTarget,
          });
        }

        dispatch({
          type: "UPSERT_SERVER",
          name: serverName,
          server: serverEntry,
        });

        saveOAuthConfigToLocalStorage(formData);
      }

      logger.info("Saved server configuration without connecting", {
        serverName,
      });
      if (!options?.suppressToast) {
        toast.success(`Saved configuration for ${serverName}`);
      }
      return true;
    },
    [
      appState.activeProjectId,
      appState.servers,
      appState.projects,
      logger,
      dispatch,
      isAuthenticated,
      useLocalFallback,
      effectiveActiveProjectId,
      effectiveProjects,
      syncServerToConvex,
      persistServerToLocalProject,
    ]
  );

  const applyTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
        authorizationServerUrl?: string;
      },
      serverUrl: string
    ): Promise<{ success: boolean; error?: string }> => {
      const tokenData = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType || "Bearer",
        expires_in: tokens.expiresIn,
      };
      if (!HOSTED_MODE && tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
          })
        );
      }

      if (!HOSTED_MODE) {
        localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);
      }

      const resolved = tryResolveProjectServer(serverName);
      const normalizedTokens = normalizeImportHostedOAuthTokens(tokenData);
      if (!resolved) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error: "OAuth server is not synced; cannot store tokens securely",
        };
      }
      if (!normalizedTokens) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error:
            "OAuth token response missing access_token; cannot import tokens to Convex",
        };
      }
      if (!tokens.clientId) {
        localStorage.removeItem(`mcp-tokens-${serverName}`);
        return {
          success: false,
          error:
            "OAuth client information missing client_id; cannot import tokens to Convex",
        };
      }
      const storedOAuthConfig = readStoredOAuthConfig(serverName);
      const isRegistry =
        !!storedOAuthConfig.registryServerId &&
        storedOAuthConfig.useRegistryOAuthProxy === true;
      await importHostedOAuthTokens({
        projectId: resolved.projectId,
        serverId: resolved.serverId,
        serverUrl,
        ...(storedOAuthConfig.resourceUrl
          ? { oauthResourceUrl: storedOAuthConfig.resourceUrl }
          : {}),
        // Forward the AS URL discovered by the debugger flow so the hosted
        // backend can refresh without re-discovering against a resource it
        // can't reach itself (e.g. localhost). Mirrors the live OAuth path in
        // MCPOAuthProvider.saveTokens.
        ...(tokens.authorizationServerUrl
          ? { authorizationServerUrl: tokens.authorizationServerUrl }
          : {}),
        kind: isRegistry ? "registry" : "generic",
        ...(isRegistry
          ? {
              registryServerId: storedOAuthConfig.registryServerId,
              useRegistryOAuthProxy: true,
            }
          : {}),
        clientInformation: {
          clientId: tokens.clientId,
          ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
        },
        tokens: normalizedTokens,
      });
      localStorage.removeItem(`mcp-tokens-${serverName}`);

      // Stamp the wire era on the config PERSISTED by CONNECT_SUCCESS.
      // `buildResolverConnectionDefaults` covers the immediate reconnect's wire
      // negotiation, but the persisted config is what hosted chat/eval/backend
      // read later (they don't consult the OAuth profile), so it must carry the
      // pin itself. An explicit stored pin wins; otherwise a just-completed
      // 2026 OAuth flow is authoritative evidence of the sessionless era (this
      // is a flow completion, not a form save, so there is no downgrade
      // ambiguity — the profile reflects the flow that just ran).
      const existingServer = appStateServersRef.current[serverName];
      const existingConfig = existingServer?.config;
      const existingWireVersion =
        existingConfig && "mcpProtocolVersion" in existingConfig
          ? existingConfig.mcpProtocolVersion
          : undefined;
      const oauthFlowWireVersion =
        existingServer?.oauthFlowProfile?.protocolVersion === "2026-07-28"
          ? ("2026-07-28" as const)
          : undefined;
      const wireVersion = existingWireVersion ?? oauthFlowWireVersion;

      const serverConfig = {
        url: serverUrl,
        ...(wireVersion ? { mcpProtocolVersion: wireVersion } : {}),
      } satisfies HttpServerConfig;

      dispatch({
        type: "CONNECT_REQUEST",
        name: serverName,
        config: serverConfig,
        select: true,
      });

      const token = nextOpToken(serverName);

      try {
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(serverConfig)
        );
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: serverConfig,
            tokens: undefined,
            useOAuth: true,
          });
          await storeInitInfo(serverName, result.initInfo);
          return { success: true };
        }
        // OAuth reconnect failure: preserve the backend-attached
        // normalized block for the same reason as the other dispatch
        // sites — the reducer's auto-derive only sees the message
        // string and produces a less specific slug than the backend
        // already pinned (e.g. via Node errno match).
        const oauthReconnectNormalized = (result as { normalized?: unknown })
          .normalized;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Connection failed",
          ...(oauthReconnectNormalized &&
          typeof oauthReconnectNormalized === "object"
            ? { normalized: oauthReconnectNormalized as NormalizedError }
            : {}),
        });
        return { success: false, error: result.error };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        return { success: false, error: errorMessage };
      }
    },
    [
      dispatch,
      storeInitInfo,
      guardedReconnectServer,
      withProjectConnectionDefaults,
    ]
  );

  // The hosted backend refreshes imported OAuth tokens from its cloud
  // environment, so an authorization server on the user's machine (or LAN)
  // is unreachable at refresh time even though the browser could reach it
  // during the debugger flow. Warn up front instead of letting the first
  // refresh fail with a discovery error.
  const warnIfHostedCannotRefresh = useCallback(
    (authorizationServerUrl?: string) => {
      if (!HOSTED_MODE || !authorizationServerUrl) return;
      if (!isPrivateNetworkUrl(authorizationServerUrl)) return;
      toast.warning(
        "This server's authorization server runs on your machine, so tokens can't auto-refresh in hosted mode. Re-run the OAuth flow when they expire, or use local mode for fully-local servers."
      );
    },
    []
  );

  const handleConnectWithTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
        authorizationServerUrl?: string;
      },
      serverUrl: string
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl
      );
      if (result.success) {
        toast.success(`Connected to ${serverName}!`);
        warnIfHostedCannotRefresh(tokens.authorizationServerUrl);
      } else {
        toast.error(`Connection failed: ${result.error}`);
      }
    },
    [
      applyTokensFromOAuthFlow,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      warnIfHostedCannotRefresh,
    ]
  );

  const handleRefreshTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
        authorizationServerUrl?: string;
      },
      serverUrl: string
    ) => {
      if (notifyIfClientConfigSyncPending()) {
        return;
      }
      if (notifyIfProjectNotProvisioned()) {
        return;
      }

      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl
      );
      if (result.success) {
        toast.success(`Tokens refreshed for ${serverName}!`);
        warnIfHostedCannotRefresh(tokens.authorizationServerUrl);
      } else {
        toast.error(`Token refresh failed: ${result.error}`);
      }
    },
    [
      applyTokensFromOAuthFlow,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      warnIfHostedCannotRefresh,
    ]
  );

  const cliConfigProcessedRef = useRef<boolean>(false);
  const cliConfigFetchStartedRef = useRef<boolean>(false);
  const cliConfigSignInRequestedRef = useRef<boolean>(false);
  const pendingCliConfigRef = useRef<any | null>(null);

  useEffect(() => {
    if (HOSTED_MODE) {
      return;
    }
    if (cliConfigProcessedRef.current) {
      return;
    }
    if (isLoading || isAuthLoading) {
      return;
    }

    const oauthCallbackInProgress = new URLSearchParams(
      window.location.search
    ).has("code");

    const applyCliUiConfig = (cliConfig: any) => {
      if (
        cliConfig.initialTab &&
        (!window.location.pathname || window.location.pathname === "/")
      ) {
        const tab = cliConfig.initialTab.replace(/^[#/]+/, "");
        if (tab) {
          navigateApp(`/${tab}`, { replace: true });
        }
      }

      if (
        cliConfig.cspMode === "permissive" ||
        cliConfig.cspMode === "widget-declared"
      ) {
        const store = useUIPlaygroundStore.getState();
        store.setCspMode(cliConfig.cspMode);
        store.setMcpAppsCspMode(cliConfig.cspMode);
      }
    };

    const hasServerPayload = (cliConfig: any): boolean =>
      Boolean(
        (Array.isArray(cliConfig.servers) && cliConfig.servers.length > 0) ||
          cliConfig.command
      );

    const formDataFromCliServer = (
      server: any,
      fallbackName = "CLI Server"
    ): ServerFormData => ({
      name: server.name || fallbackName,
      type: (server.type === "sse" ? "http" : server.type || "stdio") as
        | "stdio"
        | "http",
      command: server.command,
      args: server.args || [],
      url: server.url,
      env: server.env || {},
      headers: server.headers,
      secretPatch: {
        ...(server.env !== undefined ? { env: server.env || {} } : {}),
        ...(server.headers !== undefined
          ? { headers: server.headers || {} }
          : {}),
      },
      useOAuth: server.useOAuth ?? false,
    });

    const requestCliSignIn = () => {
      if (cliConfigSignInRequestedRef.current) {
        return;
      }
      cliConfigSignInRequestedRef.current = true;
      writeCliSignInReturnPath(
        `${window.location.pathname || routePaths.root}${
          window.location.search || ""
        }`
      );
      void requestSignIn?.();
    };

    const processCliConfig = async (cliConfig: any) => {
      applyCliUiConfig(cliConfig);

      if (!hasServerPayload(cliConfig)) {
        cliConfigProcessedRef.current = true;
        return;
      }

      if (!hasSignedInUser) {
        if (oauthCallbackInProgress) {
          logger.info("Skipping CLI sign-in redirect during OAuth callback");
          return;
        }
        requestCliSignIn();
        return;
      }

      const hasActiveConvexProject = Boolean(
        activeProject?.sharedProjectId &&
          effectiveActiveProjectId &&
          effectiveActiveProjectId !== "none" &&
          !useLocalFallback
      );
      if (isLoadingProjects || !hasActiveConvexProject) {
        return;
      }

      cliConfigProcessedRef.current = true;

      if (Array.isArray(cliConfig.servers) && cliConfig.servers.length > 0) {
        const autoConnectServer = cliConfig.autoConnectServer;

        logger.info("Processing CLI-provided MCP servers (from config file)", {
          serverCount: cliConfig.servers.length,
          autoConnectServer: autoConnectServer || "all",
          cliConfig,
        });

        for (const server of cliConfig.servers) {
          const serverName = server.name || "CLI Server";
          const formData = formDataFromCliServer(server, serverName);

          if (oauthCallbackInProgress && server.useOAuth) {
            logger.info("Skipping auto-connect for OAuth server", {
              serverName,
              reason: "OAuth callback in progress",
            });
            await saveServerConfigWithoutConnecting(formData, {
              suppressToast: true,
            });
          } else if (!autoConnectServer || server.name === autoConnectServer) {
            logger.info("Auto-connecting to server", {
              serverName,
            });
            await handleConnect(formData);
          } else {
            logger.info("Saving CLI server without auto-connect", {
              serverName,
              reason: "filtered out",
            });
            await saveServerConfigWithoutConnecting(formData, {
              suppressToast: true,
            });
          }
        }
        return;
      }

      if (cliConfig.command) {
        logger.info("Auto-connecting to CLI-provided MCP server", {
          cliConfig,
        });
        const formData = formDataFromCliServer(
          {
            ...cliConfig,
            type: "stdio",
          },
          cliConfig.name || "CLI Server"
        );
        await handleConnect(formData);
      }
    };

    const pendingCliConfig = pendingCliConfigRef.current;
    if (pendingCliConfig) {
      void processCliConfig(pendingCliConfig);
      return;
    }

    if (cliConfigFetchStartedRef.current) {
      return;
    }

    cliConfigFetchStartedRef.current = true;
    authFetch("/api/mcp-cli-config")
      .then((response) => response.json())
      .then((data) => {
        const cliConfig = data.config ?? null;
        pendingCliConfigRef.current = cliConfig;
        if (!cliConfig) {
          cliConfigProcessedRef.current = true;
          return;
        }
        void processCliConfig(cliConfig);
      })
      .catch((error) => {
        logger.debug("Could not fetch CLI config from API", { error });
        cliConfigProcessedRef.current = true;
      });
  }, [
    isLoading,
    isAuthLoading,
    isLoadingProjects,
    hasSignedInUser,
    useLocalFallback,
    effectiveActiveProjectId,
    activeProject?.sharedProjectId,
    requestSignIn,
    handleConnect,
    saveServerConfigWithoutConnecting,
    logger,
  ]);

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthTokens) return null;
      return server.oauthTokens.access_token || null;
    },
    [appState.servers]
  );

  const handleDisconnect = useCallback(
    async (serverName: string) => {
      logger.info("Disconnecting from server", { serverName });
      dispatch({ type: "DISCONNECT", name: serverName });
      try {
        const result = await deleteServer(serverName);
        if (!result.success) {
          dispatch({
            type: "DISCONNECT",
            name: serverName,
            error: result.error,
          });
        }
      } catch (error) {
        dispatch({
          type: "DISCONNECT",
          name: serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [dispatch, logger]
  );

  // Runtime-only counterpart to `handleDisconnect`. Just flips the in-memory
  // connection state to "disconnected" without going through `deleteServer`,
  // which in local mode would also remove the server's persisted config.
  // Used by host-switch auto-disconnect, where we want to drop the runtime
  // connection but keep the server entry intact so the user can re-connect
  // (or another host can require it) without re-adding the server.
  const handleRuntimeDisconnect = useCallback(
    (serverName: string) => {
      dispatch({ type: "DISCONNECT", name: serverName });
    },
    [dispatch]
  );

  const cleanupServerLocalArtifacts = useCallback((serverName: string) => {
    // Slice 5: env removal handled by Convex deleteServer; only OAuth local
    // scratchpad remains and is cleaned up here. Once Slice 2's OAuth purge
    // collapses the localStorage cache fully, this can drop too.
    clearOAuthData(serverName);
    // Env now lives on the Convex server doc; removal happens via the
    // server-delete mutation. No localStorage cleanup needed.
  }, []);

  const removeServerFromStateAndCloud = useCallback(
    async (serverName: string) => {
      cleanupServerLocalArtifacts(serverName);
      dispatch({ type: "REMOVE_SERVER", name: serverName });
      await removeServerFromConvex(serverName);
    },
    [cleanupServerLocalArtifacts, dispatch, removeServerFromConvex]
  );

  const handleRemoveServer = useCallback(
    async (serverName: string, options?: { removeFromCloud?: boolean }) => {
      logger.info("Removing server", { serverName });
      await handleDisconnect(serverName);
      if (options?.removeFromCloud === false) {
        cleanupServerLocalArtifacts(serverName);
        dispatch({ type: "REMOVE_SERVER", name: serverName });
      } else {
        await removeServerFromStateAndCloud(serverName);
      }
    },
    [
      logger,
      handleDisconnect,
      cleanupServerLocalArtifacts,
      dispatch,
      removeServerFromStateAndCloud,
    ]
  );
  handleRemoveServerRef.current = handleRemoveServer;

  const waitForServerReconnectOutcome = useCallback(
    async (
      serverName: string,
      timeoutMs = 15_000
    ): Promise<EnsureServerConnectionResult> =>
      await new Promise<EnsureServerConnectionResult>((resolve) => {
        const startedAt = Date.now();

        const check = () => {
          const server = latestEffectiveServersRef.current[serverName];
          if (!server) {
            resolve({
              status: "missing",
              error: `Server ${serverName} not found`,
            });
            return;
          }

          if (server.connectionStatus === "connected") {
            resolve({ status: "connected" });
            return;
          }

          if (server.connectionStatus === "oauth-flow") {
            resolve({
              status: "reauth",
              error: `Reauthenticate ${serverName} to continue.`,
            });
            return;
          }

          if (
            server.connectionStatus === "failed" ||
            (server.connectionStatus === "disconnected" &&
              Date.now() - startedAt > 250)
          ) {
            resolve({
              status: "failed",
              error: server.lastError || `Failed to reconnect to ${serverName}`,
            });
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            resolve({
              status: "failed",
              error: `Timed out reconnecting to ${serverName}`,
            });
            return;
          }

          window.setTimeout(check, 100);
        };

        check();
      }),
    []
  );

  const reconnectServerInternal = useCallback(
    async (
      serverName: string,
      options?: ReconnectServerInternalOptions
    ): Promise<EnsureServerConnectionResult> => {
      const select = options?.select ?? true;
      const suppressErrors = options?.suppressErrors ?? false;
      // Snapshot before anything awaits. `reportError` runs at the END of a
      // reconnect that resolved its pin from the client active at the START,
      // and the toast it raises then lives ~8s beyond that — two windows in
      // which the user can switch clients and be sent to the one client that
      // provably did not cause this.
      const hostIdAtReconnectStart = previewedHostIdRef.current;

      const reportError = (errorMessage: string) => {
        if (suppressErrors) return;
        // Reconnect is the path a user takes right AFTER changing the protocol
        // version, so it is the likeliest place to meet a pin the server
        // doesn't offer. Matched on the message because that is all this
        // helper receives; the clause is MCPJam's own wording.
        if (isProtocolVersionPinFailure(undefined, errorMessage)) {
          toastServerConnectionFailure(serverName, errorMessage, {
            action: {
              label: "Change protocol version",
              onClick: () => {
                track("change_protocol_version_clicked", {
                  location: "reconnect_failure_toast",
                  has_host_id: Boolean(hostIdAtReconnectStart),
                });
                navigateApp(
                  buildHostFocusTabPath(hostIdAtReconnectStart, "protocol")
                );
              },
            },
          });
          return;
        }
        // Everything else names the server in the toast title: a generic
        // failure ("Connection refused") says nothing about WHICH one, and
        // several can fail at once.
        toastServerConnectionFailure(serverName, errorMessage);
      };

      if (isClientConfigSyncPending) {
        const errorMessage = CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE;
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }

      const projectNotProvisionedError = getProjectNotProvisionedError();
      if (projectNotProvisionedError) {
        reportError(projectNotProvisionedError);
        return {
          status: "failed",
          error: projectNotProvisionedError,
        };
      }

      // Defer reconnects until bootstrap completes. Without this, the
      // page-load auto-reconnect loop fires before the project + server
      // mappings are loaded, hits validate without {projectId, serverId},
      // and produces "Hosted server metadata is still syncing" toasts.
      // Returning `failed` (not throwing) lets ensureServersReady move on
      // and a later trigger (project resolves, user clicks reconnect)
      // can retry against a ready app.
      if (HOSTED_MODE) {
        const projectIdForReconnect = effectiveActiveProjectIdRef.current;
        if (!projectIdForReconnect || projectIdForReconnect === "none") {
          logger.info("Deferring reconnect: app still bootstrapping", {
            serverName,
          });
          return {
            status: "failed",
            error: "App is still loading. Reconnect will retry once ready.",
          };
        }
      }

      logger.info("Reconnecting to server", { serverName, options });
      const server = latestEffectiveServersRef.current[serverName];
      if (!server) {
        const errorMessage = `Server ${serverName} not found`;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        reportError(errorMessage);
        return {
          status: "missing",
          error: errorMessage,
        };
      }

      dispatch({
        type: "RECONNECT_REQUEST",
        name: serverName,
        config: server.config,
        select,
      });
      const token = nextOpToken(serverName);
      const hostedProjectServerId = activeProjectServersFlat?.find(
        (remoteServer) => remoteServer.name === serverName
      )?._id;
      let statelessProtocolConnectCaptured = false;
      let reconnectAttemptIndex = 0;
      let hadSyncedOAuthRetry = false;
      const captureStatelessProtocolConnect = (
        metadata: StatelessProtocolConnectMetadata
      ) => {
        if (statelessProtocolConnectCaptured) {
          return;
        }
        statelessProtocolConnectCaptured = true;
        track("stateless_protocol_connect", metadata);
      };
      const buildStatelessTelemetry = (
        attempt: StatelessProtocolConnectAttempt
      ): StatelessProtocolConnectTelemetry => ({
        attempt,
        attemptIndex: (reconnectAttemptIndex += 1),
        select,
        suppressErrors,
        allowInteractiveOAuthFlow: options?.allowInteractiveOAuthFlow ?? false,
        hadSyncedOAuthRetry,
        capture: captureStatelessProtocolConnect,
      });

      if (options?.forceOAuthFlow) {
        const serverUrl = (server.config as any)?.url?.toString?.();
        if (!serverUrl) {
          const errorMessage = "No server URL found for OAuth flow";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return {
            status: "failed",
            error: errorMessage,
          };
        }

        const storedOAuthConfig = readStoredOAuthConfig(serverName);
        const storedClientCredentials = readStoredClientCredentials(serverName);
        const profileScopes = parseOAuthScopes(server.oauthFlowProfile?.scopes);
        const profileHeaders = profileHeadersToRecord(
          server.oauthFlowProfile?.customHeaders
        );
        const rawHostPin = activeMcpProfile?.mcpProtocolVersion;
        const hostPin =
          typeof rawHostPin === "string" && isKnownProtocolVersion(rawHostPin)
            ? rawHostPin
            : undefined;
        const protocolSelection = resolveOAuthProtocolSelection({
          mode:
            server.oauthProtocolMode ??
            server.oauthFlowProfile?.protocolVersion ??
            storedOAuthConfig.protocolMode,
          legacyProtocolVersion: storedOAuthConfig.protocolVersion,
          wireProtocolVersion: resolveEffectiveWireProtocolVersion({
            serverConfig: server.config,
            server,
            serverOverride: undefined,
            hostPin,
          }),
          negotiatedProtocolVersion: server.initializationInfo?.protocolVersion,
        });
        // Canonical per-server registrationMode wins over the legacy
        // profile/localStorage concretes — a persisted "auto" must keep
        // resolving from current server metadata on forced reconnects too
        // (same precedence as buildReconnectOAuthOptions in
        // oauth-orchestrator.ts).
        const registrationMode =
          normalizeRegistrationMode(server.registrationMode) ??
          server.oauthFlowProfile?.registrationStrategy ??
          storedOAuthConfig.registrationMode ??
          "auto";
        // A rejected configured resource indicator has to read as a
        // configuration failure, not an unhandled throw — the builder refuses
        // it BEFORE the redirect, which is the point, but the user still needs
        // to be told why.
        let oauthOptions: BuiltOAuthRequest;
        try {
          oauthOptions = buildOAuthRequest(
            {
              serverName,
              serverUrl,
              scopes: profileScopes ?? storedOAuthConfig.scopes,
              // Same staleness gate as the connect path: a stored resource
              // belongs to the endpoint it was captured for.
              resourceUrl: selectStoredResourceUrl(serverUrl, [
                {
                  resourceUrl: server.oauthFlowProfile?.resourceUrl,
                  capturedForServerUrl: server.oauthFlowProfile?.serverUrl,
                },
                {
                  resourceUrl: storedOAuthConfig.resourceUrl,
                  capturedForServerUrl:
                    localStorage.getItem(`mcp-serverUrl-${serverName}`) ??
                    undefined,
                },
              ]),
              clientId:
                server.oauthTokens?.client_id ??
                server.oauthFlowProfile?.clientId ??
                storedClientCredentials.clientId,
              clientSecret: undefined,
              hasClientSecret: Boolean(server.hasClientSecret),
              customHeaders: mergeWithProjectHeaders(
                profileHeaders ??
                  ("requestInit" in server.config
                    ? extractRequestHeaders(server.config.requestInit)
                    : undefined) ??
                  storedOAuthConfig.customHeaders
              ),
              registryServerId: storedOAuthConfig.registryServerId,
              useRegistryOAuthProxy: storedOAuthConfig.useRegistryOAuthProxy,
              // See the initial-connect path: the reconnect flow must honor the
              // same per-server opt-in, or a reconnect fails where connect
              // worked.
              allowPathScopedIssuer: server.oauthAllowPathScopedIssuer === true,
              protocolMode: protocolSelection.mode,
              registrationMode,
              protocolVersion: protocolSelection.protocolVersion,
              protocolResolutionSource: protocolSelection.source,
              registrationStrategy:
                server.oauthFlowProfile?.registrationStrategy ??
                storedOAuthConfig.registrationStrategy,
              onTraceUpdate: (oauthTrace: OAuthTrace) => {
                updateServerOAuthTrace(serverName, oauthTrace);
              },
            },
            { intent: "reconnect" }
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to build the OAuth request";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return { status: "failed", error: errorMessage };
        }

        clearOAuthData(serverName);
        dispatch({
          type: "UPSERT_SERVER",
          name: serverName,
          server: {
            ...server,
            connectionStatus: "oauth-flow",
            enabled: true,
            lastError: undefined,
            useOAuth: true,
          },
        });
        let oauthResult: Awaited<ReturnType<typeof initiateOAuth>>;
        try {
          await deleteServer(serverName);

          prepareHostedProjectOAuthRedirect({
            serverId: hostedProjectServerId,
            serverName,
            serverUrl,
          });
          oauthResult = await initiateOAuth(oauthOptions);
        } catch (error) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error:
                error instanceof Error ? error.message : "OAuth flow failed",
            };
          }
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to start OAuth flow";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return {
            status: "failed",
            error: errorMessage,
          };
        }

        if (oauthResult.success && !oauthResult.serverConfig) {
          return {
            status: "reauth",
            error: `Reauthenticate ${serverName} to continue.`,
          };
        }
        if (!oauthResult.success) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: oauthResult.error || "OAuth flow failed",
            };
          }
          const errorMessage = oauthResult.error || "OAuth flow failed";
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
            oauthTrace: oauthResult.oauthTrace,
          });
          reportError(`OAuth failed: ${serverName}`);
          return {
            status: "failed",
            error: errorMessage,
          };
        }
        const oauthServerConfig = stripAuthorizationFromHttpConfig(
          oauthResult.serverConfig!
        );
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(oauthServerConfig),
          buildStatelessTelemetry("forced_oauth")
        );
        if (isStaleOp(serverName, token)) {
          return {
            status: "superseded",
            error: result.error || "Reconnection failed after OAuth",
          };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: oauthServerConfig,
            tokens: undefined,
            useOAuth: true,
            oauthTrace: oauthResult.oauthTrace,
          });
          logger.info("Reconnection with fresh OAuth successful", {
            serverName,
          });
          storeInitInfo(serverName, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err })
          );
          return { status: "connected" };
        }
        const errorMessage = result.error || "Reconnection failed after OAuth";
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
          oauthTrace: oauthResult.oauthTrace,
        });
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }

      // Auto's escalation gate for the reconnect path: same confirm +
      // pending/succeeded/failed lifecycle as handleConnect. Returns null to
      // proceed into the interactive flow, or the outcome to return
      // immediately. Keyed by project + server id so identically named
      // servers across projects don't share state.
      const escalationIdentity: AutoEscalationIdentity = {
        projectId: appState.activeProjectId,
        serverId: hostedProjectServerId ?? null,
        serverName,
      };
      let autoInteractiveConfirmed = false;
      const gateAutoEscalation = async (): Promise<null | {
        status: "failed" | "reauth" | "superseded";
        error: string;
      }> => {
        if (server.authMethod !== "auto") return null;
        const fail = (errorMessage: string, status: "failed" | "reauth") => {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: errorMessage,
          });
          reportError(errorMessage);
          return { status, error: errorMessage };
        };
        if (autoOAuthEscalation.hasPendingAttempt(escalationIdentity)) {
          // A confirmed flow already ran this session and the server 401'd
          // again — surface the config problem and clear, so a later manual
          // attempt re-prompts instead of being muted all session.
          autoOAuthEscalation.markFailed(escalationIdentity);
          return fail(
            `Server "${serverName}" still returns 401 after OAuth. Check the server's authorization configuration.`,
            "failed"
          );
        }
        if (options?.allowInteractiveOAuthFlow === false) {
          // Non-interactive reconnect-all (client/host switch, load loop):
          // never prompt or redirect from here; a manual reconnect offers
          // the escalation.
          return fail(
            `Server "${serverName}" requires authorization. Reconnect to sign in with OAuth.`,
            "reauth"
          );
        }
        const proceed = await confirmAutoOAuthEscalation(serverName);
        // A newer op superseded this one while the prompt sat open — don't
        // write ITS marker state (that would poison the newer attempt).
        if (isStaleOp(serverName, token)) {
          return {
            status: "superseded",
            error: "Reconnection superseded",
          };
        }
        if (!proceed) {
          return fail(
            `Server "${serverName}" requires authorization. Reconnect to sign in with OAuth.`,
            "failed"
          );
        }
        autoOAuthEscalation.markPending(escalationIdentity);
        autoInteractiveConfirmed = true;
        return null;
      };

      if (server.useOAuth === true) {
        const syncedReconnectConfig = withProjectConnectionDefaults(
          server.config
        );
        try {
          const result = await guardedReconnectServer(
            serverName,
            syncedReconnectConfig,
            buildStatelessTelemetry("synced_oauth_credentials")
          );
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: result.error || "Reconnection failed",
            };
          }
          if (result.success) {
            autoOAuthEscalation.markSucceeded(escalationIdentity);
            dispatch({
              type: "CONNECT_SUCCESS",
              name: serverName,
              config: server.config,
              tokens: undefined,
              useOAuth: true,
            });
            logger.info("Reconnect successful using synced OAuth credentials", {
              serverName,
              result,
            });
            storeInitInfo(serverName, result.initInfo).catch((err) =>
              logger.warn("Failed to fetch init info", { serverName, err })
            );
            return { status: "connected" };
          }

          if (!connectFailureRequiresOAuth(result)) {
            const errorMessage = result.error || "Reconnection failed";
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
            });
            logger.error("OAuth reconnect failed", { serverName, result });
            reportError(errorMessage || `Failed to reconnect: ${serverName}`);
            return {
              status: "failed",
              error: errorMessage,
            };
          }

          const gated = await gateAutoEscalation();
          if (gated) return gated;
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: result.error || "Reconnection failed",
            };
          }

          logger.info(
            "Reconnect requires a fresh OAuth flow after synced credential lookup",
            { serverName, error: result.error }
          );
          hadSyncedOAuthRetry = true;
        } catch (error) {
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }

          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          if (!requiresFreshOAuthAuthorization(error)) {
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
            });
            logger.error("OAuth reconnect failed", {
              serverName,
              error: errorMessage,
            });
            reportError(errorMessage || `Failed to reconnect: ${serverName}`);
            return {
              status: "failed",
              error: errorMessage,
            };
          }

          const gated = await gateAutoEscalation();
          if (gated) return gated;
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: errorMessage,
            };
          }

          logger.info(
            "Reconnect requires a fresh OAuth flow after synced credential lookup",
            { serverName, error: errorMessage }
          );
          hadSyncedOAuthRetry = true;
        }
      }

      try {
        const authResult: OAuthResult = await ensureAuthorizedForReconnect(
          server,
          {
            beforeRedirect: (oauthOptions) => {
              prepareHostedProjectOAuthRedirect({
                serverId: hostedProjectServerId,
                serverName,
                serverUrl: oauthOptions.serverUrl,
              });
            },
            onTraceUpdate: (oauthTrace: OAuthTrace) => {
              updateServerOAuthTrace(serverName, oauthTrace);
            },
            allowInteractiveOAuthFlow: options?.allowInteractiveOAuthFlow,
            // Auto servers reach the interactive flow only through the
            // user-confirmed escalation gate above; without this flag the
            // orchestrator treats a tokenless auto server as
            // ready-unauthenticated instead of redirecting.
            interactiveOAuthConfirmed: autoInteractiveConfirmed,
          }
        );
        if (authResult.kind === "redirect") {
          return {
            status: "reauth",
            error: `Reauthenticate ${serverName} to continue.`,
          };
        }
        if (authResult.kind === "reauth_required") {
          if (isStaleOp(serverName, token)) {
            return {
              status: "reauth",
              error: authResult.error,
            };
          }
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
            oauthTrace: authResult.oauthTrace,
          });
          reportError(authResult.error);
          return {
            status: "reauth",
            error: authResult.error,
          };
        }
        if (authResult.kind === "error") {
          if (isStaleOp(serverName, token)) {
            return {
              status: "superseded",
              error: authResult.error,
            };
          }
          if (autoInteractiveConfirmed) {
            // OAuth init failed before any redirect — nothing is pending.
            autoOAuthEscalation.markFailed(escalationIdentity);
          }
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
            oauthTrace: authResult.oauthTrace,
          });
          reportError(`Failed to connect: ${serverName}`);
          return {
            status: "failed",
            error: authResult.error,
          };
        }
        const authServerConfig =
          "url" in authResult.serverConfig
            ? stripAuthorizationFromHttpConfig(authResult.serverConfig)
            : authResult.serverConfig;
        const result = await guardedReconnectServer(
          serverName,
          withProjectConnectionDefaults(authServerConfig),
          buildStatelessTelemetry("authorized_reconnect")
        );
        if (isStaleOp(serverName, token)) {
          return {
            status: "superseded",
            error: result.error || "Reconnection failed",
          };
        }
        if (result.success) {
          autoOAuthEscalation.markSucceeded(escalationIdentity);
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: authServerConfig,
            tokens: authResult.tokens,
            useOAuth: server.useOAuth === true || authResult.tokens != null,
            oauthTrace: authResult.oauthTrace,
          });
          logger.info("Reconnection successful", { serverName, result });
          storeInitInfo(serverName, result.initInfo).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err })
          );
          return { status: "connected" };
        }
        if (autoInteractiveConfirmed) {
          // Terminal in this page-session: OAuth completed but the connect
          // failed. Clear the pending marker so a later manual attempt
          // re-prompts instead of being muted all session.
          autoOAuthEscalation.markFailed(escalationIdentity);
        }
        const errorMessage = result.error || "Reconnection failed";
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
          oauthTrace: authResult.oauthTrace,
          // Preserve the backend-attached normalized block so the reducer
          // doesn't have to re-derive a (less specific) slug from just
          // the message string.
          ...(result.normalized ? { normalized: result.normalized } : {}),
        });
        logger.error("Reconnection failed", { serverName, result });
        reportError(errorMessage || `Failed to reconnect: ${serverName}`);
        return {
          status: "failed",
          error: errorMessage,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) {
          return {
            status: "superseded",
            error: errorMessage,
          };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        reportError(errorMessage);
        return {
          status: "failed",
          error: errorMessage,
        };
      }
    },
    [
      activeProjectServersFlat,
      isAuthenticated,
      isClientConfigSyncPending,
      getProjectNotProvisionedError,
      storeInitInfo,
      logger,
      dispatch,
      prepareHostedProjectOAuthRedirect,
      guardedReconnectServer,
      mergeWithProjectHeaders,
      updateServerOAuthTrace,
      withProjectConnectionDefaults,
    ]
  );

  const handleReconnect = useCallback(
    async (
      serverName: string,
      options?: {
        forceOAuthFlow?: boolean;
        allowInteractiveOAuthFlow?: boolean;
      }
    ) => {
      await reconnectServerInternal(serverName, {
        forceOAuthFlow: options?.forceOAuthFlow,
        allowInteractiveOAuthFlow: options?.allowInteractiveOAuthFlow ?? true,
        select: true,
      });
    },
    [reconnectServerInternal]
  );

  /**
   * Connect a saved server and REPORT what happened.
   *
   * `handleConnect`/`handleReconnect` are built for buttons: they resolve to
   * `void`, swallow failures into toasts, and may hand the page to an OAuth
   * redirect. An agent driving the UI needs the opposite of all three — it
   * has to tell the user the outcome, and a tool call that ends in
   * `window.location.assign` never returns a result at all.
   *
   * So: `allowInteractiveOAuthFlow: false`, which makes the internal path
   * return `reauth` instead of redirecting. The caller reports "this server
   * needs authorization" and the user clicks Authorize themselves — the
   * consent stays a human decision, taken with the page intact.
   *
   * `suppressErrors` because the caller renders the outcome; a toast on top
   * would double-report it.
   */
  const connectServerWithResult = useCallback(
    async (
      serverName: string,
      options?: { select?: boolean }
    ): Promise<EnsureServerConnectionResult> =>
      await reconnectServerInternal(serverName, {
        // Deliberately NOT exposing `forceOAuthFlow`: it can drive the page
        // into an OAuth redirect, and the whole contract of this helper is
        // that it never navigates — it returns `reauth` and lets the user
        // click Authorize. A caller that could force the flow would break
        // that promise.
        allowInteractiveOAuthFlow: false,
        select: options?.select ?? true,
        suppressErrors: true,
      }),
    [reconnectServerInternal]
  );

  // Force a re-handshake of an ALREADY-connected server under the current
  // client identity. Unlike `ensureServersReady` (which skips servers that are
  // already connected), this always reconnects — the backend
  // `/api/mcp/servers/reconnect` endpoint closes the live transport and reopens
  // it with the active host's `clientInfo`. Non-interactive and non-selecting:
  // used by the client-switch recycle, where popping an OAuth window per server
  // or thrashing the single-select pointer would be wrong. Per-server error
  // toasts are suppressed here; the caller aggregates failures for logging and
  // one user-facing toast.
  const reconnectServerForClientSwitch = useCallback(
    async (serverName: string): Promise<void> => {
      const result = await reconnectServerInternal(serverName, {
        allowInteractiveOAuthFlow: false,
        select: false,
        suppressErrors: true,
      });
      // "superseded" means a newer connect/reconnect op for this server took
      // over while this one was in flight (e.g. the user kept switching
      // clients). The connection is just in progress under the newer op, which
      // owns the outcome — not a failure. Treat it as a no-op so the
      // client-switch recycle doesn't surface a spurious "Failed to reconnect"
      // toast.
      if (result.status === "connected" || result.status === "superseded") {
        return;
      }
      throw new Error(result.error || `Failed to reconnect ${serverName}`);
    },
    [reconnectServerInternal]
  );

  const ensureServersReady = useCallback(
    async (serverNames: string[]): Promise<EnsureServersReadyResult> => {
      const uniqueServerNames = [...new Set(serverNames.filter(Boolean))];

      const resolveToProjectServerKey = (serverRef: string): string => {
        const effective = latestEffectiveServersRef.current;
        if (effective[serverRef]) {
          return serverRef;
        }

        const fromProject = activeProjectServersFlat?.find(
          (s) => s._id === serverRef
        );
        if (fromProject) {
          return fromProject.name;
        }

        if (HOSTED_MODE) {
          const hosted = tryGetHostedServerDisplayName(serverRef);
          if (hosted && effective[hosted]) {
            return hosted;
          }
        }

        return serverRef;
      };

      // Multiple refs (e.g. hosted id and display name) can collapse to the
      // same project server. Group by resolved key so we only kick off one
      // reconnect per real server and avoid spurious "stale op" failures.
      type RefGroup = { resolvedKey: string; refs: string[] };
      const groupsByKey = new Map<string, RefGroup>();
      const orderedKeys: string[] = [];
      for (const serverName of uniqueServerNames) {
        const resolvedKey = resolveToProjectServerKey(serverName);
        const existing = groupsByKey.get(resolvedKey);
        if (existing) {
          existing.refs.push(serverName);
        } else {
          groupsByKey.set(resolvedKey, { resolvedKey, refs: [serverName] });
          orderedKeys.push(resolvedKey);
        }
      }

      const outcomesByKey = await Promise.all(
        orderedKeys.map(
          async (
            resolvedKey
          ): Promise<readonly [string, EnsureServerConnectionResult]> => {
            const server = latestEffectiveServersRef.current[resolvedKey];
            if (!server) {
              return [
                resolvedKey,
                {
                  status: "missing",
                  error: `Server ${resolvedKey} not found`,
                },
              ] as const;
            }

            if (server.connectionStatus === "connected") {
              return [resolvedKey, { status: "connected" }] as const;
            }

            if (server.connectionStatus === "connecting") {
              return [
                resolvedKey,
                await waitForServerReconnectOutcome(resolvedKey),
              ] as const;
            }

            if (server.connectionStatus === "oauth-flow") {
              return [
                resolvedKey,
                {
                  status: "reauth",
                  error: `Reauthenticate ${resolvedKey} to continue.`,
                },
              ] as const;
            }

            const outcome = await reconnectServerInternal(resolvedKey, {
              allowInteractiveOAuthFlow: false,
              select: false,
              suppressErrors: true,
            });

            // "superseded" means a newer connect op took the pin mid-flight
            // (e.g. the host-switch recycle racing a send). That op — not this
            // one — drives the server to its final state, so returning
            // superseded here would leave the server in NO bucket: not ready,
            // not failed. Callers that gate on `readyServerNames` (the chat
            // send path) then refuse to send even though the server is about
            // to be connected. Follow the newer op to its real outcome.
            if (outcome.status === "superseded") {
              return [
                resolvedKey,
                await waitForServerReconnectOutcome(resolvedKey),
              ] as const;
            }

            return [resolvedKey, outcome] as const;
          }
        )
      );

      const outcomeByKey = new Map(outcomesByKey);
      const outcomes: ReadonlyArray<
        readonly [string, EnsureServerConnectionResult]
      > = uniqueServerNames.map((serverName) => {
        const resolvedKey = resolveToProjectServerKey(serverName);
        const outcome = outcomeByKey.get(resolvedKey) ?? {
          status: "missing",
          error: `Server ${serverName} not found`,
        };
        return [serverName, outcome] as const;
      });

      const readyServerNames: string[] = [];
      const missingServerNames: string[] = [];
      const failedServerNames: string[] = [];
      const reauthServerNames: string[] = [];

      for (const [serverName, outcome] of outcomes) {
        switch (outcome.status) {
          case "connected":
            readyServerNames.push(serverName);
            break;
          case "missing":
            missingServerNames.push(serverName);
            break;
          case "reauth":
            reauthServerNames.push(serverName);
            break;
          case "superseded":
            // Resolved above by following the newer op to its real outcome, so
            // this is unreachable in practice. Kept as a defensive branch: a
            // superseded connection is still in progress, and classifying it
            // as failed would raise a false "failed to connect".
            break;
          case "failed":
          default:
            failedServerNames.push(serverName);
            break;
        }
      }

      return {
        readyServerNames,
        missingServerNames,
        failedServerNames,
        reauthServerNames,
      };
    },
    [
      activeProjectServersFlat,
      reconnectServerInternal,
      waitForServerReconnectOutcome,
    ]
  );

  const syncAgentStatus = useCallback(async () => {
    try {
      const result = await listServers();
      if (result?.success && Array.isArray(result.servers)) {
        dispatch({ type: "SYNC_AGENT_STATUS", servers: result.servers });
      }
      return result;
    } catch (error) {
      logger.debug("Failed to sync server status", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }, [logger, dispatch]);

  useEffect(() => {
    if (isLoading) return;
    void syncAgentStatus().catch((error) => {
      logger.debug("Startup server status sync failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }, [isLoading, logger, syncAgentStatus]);

  const setSelectedServer = useCallback(
    (serverName: string) => {
      dispatch({ type: "SELECT_SERVER", name: serverName });
    },
    [dispatch]
  );

  const setSelectedMCPConfigs = useCallback(
    (serverNames: string[]) => {
      dispatch({ type: "SET_MULTI_SELECTED", names: serverNames });
    },
    [dispatch]
  );

  const toggleMultiSelectMode = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "SET_MULTI_MODE", enabled });
    },
    [dispatch]
  );

  const toggleServerSelection = useCallback(
    (serverName: string) => {
      const current = appState.selectedMultipleServers;
      const next = current.includes(serverName)
        ? current.filter((n) => n !== serverName)
        : [...current, serverName];
      dispatch({ type: "SET_MULTI_SELECTED", names: next });
    },
    [appState.selectedMultipleServers, dispatch]
  );

  const handleUpdate = useCallback(
    async (
      originalServerName: string,
      formData: ServerFormData,
      skipAutoConnect?: boolean
    ): Promise<ServerUpdateResult> => {
      const nextServerName = formData.name.trim();
      if (!nextServerName) {
        toast.error("Server name is required");
        return { ok: false, serverName: originalServerName };
      }
      const isRename = nextServerName !== originalServerName;
      const activeProjectServers =
        effectiveProjects[effectiveActiveProjectId]?.servers ?? {};
      if (isRename && activeProjectServers[nextServerName]) {
        toast.error(
          `A server named "${nextServerName}" already exists. Choose a different name.`
        );
        return { ok: false, serverName: originalServerName };
      }
      const originalServer =
        appState.servers[originalServerName] ??
        effectiveServers[originalServerName];

      if (skipAutoConnect) {
        const mcpConfig = toMCPConfig(formData);
        if (isRename) {
          await handleDisconnect(originalServerName);
          await removeServerFromStateAndCloud(originalServerName);
        }

        const updatedServer: ServerWithName = {
          ...(originalServer ?? {}),
          name: nextServerName,
          config: mcpConfig,
          lastConnectionTime: originalServer?.lastConnectionTime ?? new Date(),
          connectionStatus: originalServer?.connectionStatus ?? "disconnected",
          retryCount: originalServer?.retryCount ?? 0,
          enabled: originalServer?.enabled ?? false,
          oauthTokens: originalServer?.oauthTokens,
          oauthFlowProfile:
            formData.useOAuth || formData.useXaa
              ? buildOAuthProfileFromFormData(
                  formData,
                  originalServer?.oauthFlowProfile
                ) ?? originalServer?.oauthFlowProfile
              : undefined,
          initializationInfo: originalServer?.initializationInfo,
          useOAuth: formData.useOAuth ?? false,
          oauthProtocolMode: formData.useOAuth
            ? formData.oauthProtocolMode ?? originalServer?.oauthProtocolMode
            : undefined,
          xaaAuthzIssuer:
            formData.xaaAuthzIssuer ?? originalServer?.xaaAuthzIssuer,
          xaaAllowPathScopedIssuer:
            formData.xaaAllowPathScopedIssuer ??
            originalServer?.xaaAllowPathScopedIssuer,
          oauthAllowPathScopedIssuer:
            formData.oauthAllowPathScopedIssuer ??
            originalServer?.oauthAllowPathScopedIssuer,
          useXaa: formData.useXaa ?? false,
          // Shared atomic identity-pair semantics (omitted pair preserves
          // the stored values, explicit "" pair clears) + authServerMode
          // default.
          ...resolveXaaIdentitySaveFields({
            useXaa: formData.useXaa === true,
            formAuthServerMode: formData.authServerMode,
            formSubject: formData.xaaSubject,
            formEmail: formData.xaaEmail,
            existing: originalServer,
          }),
          // Unified fields: preserve any saved value when a save that omits
          // them comes through, rather than erasing it.
          xaaIdentityAssertionFormat:
            formData.xaaIdentityAssertionFormat ??
            originalServer?.xaaIdentityAssertionFormat,
          xaaClientAuth:
            formData.xaaClientAuth ?? originalServer?.xaaClientAuth,
          registrationMode:
            formData.registrationMode ?? originalServer?.registrationMode,
          authMethod: formData.authMethod ?? originalServer?.authMethod,
        } as ServerWithName;

        if (!formData.useOAuth && !formData.useXaa) {
          clearOAuthData(nextServerName);
        }
        dispatch({
          type: "UPSERT_SERVER",
          name: nextServerName,
          server: updatedServer,
        });

        if (!isAuthenticated || useLocalFallback) {
          persistServerToLocalProject(nextServerName, updatedServer, {
            originalServerName: isRename ? originalServerName : undefined,
          });
        } else {
          const synced = await syncServerToConvex(
            nextServerName,
            updatedServer
          );
          // Nothing was written, so the success toast below would be a lie.
          if (!synced.ok) {
            toast.error(
              synced.reason === "workspace-name-taken"
                ? `A server named "${nextServerName}" already exists in this workspace. Choose a different name.`
                : "Could not save the server configuration. Please try again."
            );
            return { ok: false, serverName: originalServerName };
          }
        }

        saveOAuthConfigToLocalStorage(formData);
        if (appState.selectedServer === originalServerName && isRename) {
          setSelectedServer(nextServerName);
        }
        toast.success("Server configuration updated");
        return { ok: true, serverName: nextServerName };
      }

      const hadOAuthTokens = originalServer?.oauthTokens != null;
      if (notifyIfClientConfigSyncPending()) {
        return { ok: false, serverName: originalServerName };
      }
      if (notifyIfProjectNotProvisioned()) {
        return { ok: false, serverName: originalServerName };
      }

      // The fast path below re-tests the existing connection and returns
      // without writing any server fields, so a settings-only edit would be
      // silently discarded. The issuer opt-in changes how discovery is
      // validated, so a change to it must take the full save path.
      const pathScopedIssuerChanged =
        formData.oauthAllowPathScopedIssuer !== undefined &&
        formData.oauthAllowPathScopedIssuer !==
          (originalServer?.oauthAllowPathScopedIssuer === true);

      const shouldPreserveOAuth =
        hadOAuthTokens &&
        !pathScopedIssuerChanged &&
        formData.useOAuth &&
        nextServerName === originalServerName &&
        formData.type === "http" &&
        formData.url === (originalServer?.config as any).url?.toString();

      if (shouldPreserveOAuth && originalServer) {
        const mcpConfig = toMCPConfig(formData);
        dispatch({
          type: "CONNECT_REQUEST",
          name: originalServerName,
          config: mcpConfig,
        });
        saveOAuthConfigToLocalStorage(formData);
        try {
          const result = await guardedTestConnection(
            withProjectConnectionDefaults(originalServer.config),
            originalServerName
          );
          if (result.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name: originalServerName,
              config: mcpConfig,
              useOAuth: true,
            });
            await storeInitInfo(originalServerName, result.initInfo);
            toast.success("Server configuration updated successfully!");
            return { ok: true, serverName: originalServerName };
          }
          console.warn(
            "OAuth connection test failed, falling back to full reconnect"
          );
        } catch (error) {
          console.warn(
            "OAuth connection test error, falling back to full reconnect",
            error
          );
        }
      }

      if (hadOAuthTokens && !formData.useOAuth) {
        clearOAuthData(originalServerName);
      }

      saveOAuthConfigToLocalStorage(formData);

      if (isRename) {
        await handleDisconnect(originalServerName);
        await removeServerFromStateAndCloud(originalServerName);
      } else {
        await handleDisconnect(originalServerName);
      }
      await handleConnect(formData);
      if (
        appState.selectedServer === originalServerName &&
        nextServerName !== originalServerName
      ) {
        setSelectedServer(nextServerName);
      }
      return { ok: true, serverName: nextServerName };
    },
    [
      appState.servers,
      appState.activeProjectId,
      appState.projects,
      appState.selectedServer,
      dispatch,
      effectiveProjects,
      effectiveActiveProjectId,
      effectiveServers,
      storeInitInfo,
      handleDisconnect,
      handleConnect,
      isAuthenticated,
      removeServerFromStateAndCloud,
      setSelectedServer,
      syncServerToConvex,
      useLocalFallback,
      persistServerToLocalProject,
      notifyIfClientConfigSyncPending,
      notifyIfProjectNotProvisioned,
      guardedTestConnection,
    ]
  );

  return {
    activeProject,
    effectiveServers,
    projectServers: effectiveServers,
    displayServerConfigs,
    connectedOrConnectingServerConfigs,
    selectedServerEntry: effectiveServers[appState.selectedServer],
    selectedMCPConfig: effectiveServers[appState.selectedServer]?.config,
    selectedMCPConfigs: appState.selectedMultipleServers
      .map((name) => effectiveServers[name])
      .filter(Boolean),
    selectedMCPConfigsMap: appState.selectedMultipleServers.reduce(
      (acc, name) => {
        if (effectiveServers[name]) {
          acc[name] = effectiveServers[name].config;
        }
        return acc;
      },
      {} as Record<string, MCPServerConfig>
    ),
    isMultiSelectMode: appState.isMultiSelectMode,
    handleConnect,
    handleDisconnect,
    handleRuntimeDisconnect,
    handleReconnect,
    connectServerWithResult,
    reconnectServerForClientSwitch,
    ensureServersReady,
    syncAgentStatus,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleMultiSelectMode,
    toggleServerSelection,
    getValidAccessToken,
    setSelectedMultipleServersToAllServers,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
    persistRuntimeServerToProjectIfNeeded,
    ensureHostedServerIdsForNames,
  };
}
