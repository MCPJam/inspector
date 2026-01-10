/**
 * OAuth 2.0 State Machine for MCP - 2025-11-25 Protocol (Draft)
 *
 * This implementation follows the 2025-11-25 MCP OAuth specification:
 * - Registration priority: CIMD (SHOULD) > Pre-registered > DCR (MAY)
 * - Discovery: OAuth 2.0 (RFC8414) OR OpenID Connect Discovery 1.0 with path insertion priority
 * - PKCE: REQUIRED - MUST verify code_challenge_methods_supported
 * - Client ID Metadata Documents (CIMD) support per draft-parecki-oauth-client-id-metadata-document-03
 */

import { decodeJWT, formatJWTTimestamp } from "../jwt-decoder";
import { MCPJAM_CLIENT_ID } from "../constants";
import { EMPTY_OAUTH_FLOW_STATE } from "./types";
import type {
  OAuthFlowStep,
  OAuthFlowState,
  OAuthStateMachine,
  HttpHistoryEntry,
  RegistrationStrategy2025_11_25,
} from "./types";
import type { DiagramAction } from "./shared/types";
import {
  proxyFetch,
  addInfoLog,
  generateRandomString,
  generateCodeChallenge,
  loadPreregisteredCredentials,
  buildResourceMetadataUrl,
  markLatestHttpEntryAsError,
  toLogErrorDetails,
} from "./shared/helpers";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";

/**
 * Canonicalize a URL for use as a resource parameter per RFC 8707
 * - Lowercase scheme and host
 * - Remove fragment
 * - Remove trailing slash (unless path is just "/")
 */
function canonicalizeResourceUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Lowercase scheme and host
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    // Remove fragment
    parsed.hash = "";

    // Remove trailing slash unless it's the root path
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch (error) {
    console.warn("Failed to canonicalize resource URL:", url, error);
    return url; // Return original if parsing fails
  }
}

// Re-export types for backward compatibility
export type { OAuthFlowStep, OAuthFlowState };
export { EMPTY_OAUTH_FLOW_STATE };

// Legacy type alias
export type OauthFlowStateJune2025 = OAuthFlowState;

// Legacy state export
export const EMPTY_OAUTH_FLOW_STATE_V2: OauthFlowStateJune2025 =
  EMPTY_OAUTH_FLOW_STATE;

// Configuration for creating the state machine (2025-11-25 specific)
export interface DebugOAuthStateMachineConfig {
  state: OauthFlowStateJune2025;
  getState?: () => OauthFlowStateJune2025;
  updateState: (updates: Partial<OauthFlowStateJune2025>) => void;
  serverUrl: string;
  serverName: string;
  redirectUrl?: string;
  fetchFn?: typeof fetch;
  customScopes?: string;
  customHeaders?: Record<string, string>;
  registrationStrategy?: RegistrationStrategy2025_11_25; // cimd | dcr | preregistered
}

/**
 * Build the sequence of actions for the 2025-11-25 OAuth flow
 * This function creates the visual representation of the OAuth flow steps
 * that will be displayed in the sequence diagram.
 */
export function buildActions_2025_11_25(
  flowState: OAuthFlowState,
  registrationStrategy: "cimd" | "dcr" | "preregistered",
): DiagramAction[] {
  return [
    {
      id: "request_without_token",
      label: "MCP request without token",
      description: "Client makes initial request without authorization",
      from: "client",
      to: "mcpServer",
      details: flowState.serverUrl
        ? [
            { label: "POST", value: flowState.serverUrl },
            { label: "method", value: "initialize" },
          ]
        : undefined,
    },
    {
      id: "received_401_unauthorized",
      label: "HTTP 401 Unauthorized with WWW-Authenticate header",
      description: "Server returns 401 with WWW-Authenticate header",
      from: "mcpServer",
      to: "client",
      details: flowState.resourceMetadataUrl
        ? [{ label: "Note", value: "Extract resource_metadata URL" }]
        : undefined,
    },
    {
      id: "request_resource_metadata",
      label: "Request Protected Resource Metadata",
      description: "Client requests metadata from well-known URI",
      from: "client",
      to: "mcpServer",
      details: flowState.resourceMetadataUrl
        ? [
            {
              label: "GET",
              value: new URL(flowState.resourceMetadataUrl).pathname,
            },
          ]
        : undefined,
    },
    {
      id: "received_resource_metadata",
      label: "Return metadata",
      description: "Server returns OAuth protected resource metadata",
      from: "mcpServer",
      to: "client",
      details: flowState.resourceMetadata?.authorization_servers
        ? [
            {
              label: "Auth Server",
              value: flowState.resourceMetadata.authorization_servers[0],
            },
          ]
        : undefined,
    },
    {
      id: "request_authorization_server_metadata",
      label: "GET Authorization server metadata endpoint",
      description:
        "Try OAuth path insertion, OIDC path insertion, OIDC path appending",
      from: "client",
      to: "authServer",
      details: flowState.authorizationServerUrl
        ? [
            { label: "URL", value: flowState.authorizationServerUrl },
            { label: "Protocol", value: "2025-11-25" },
          ]
        : undefined,
    },
    {
      id: "received_authorization_server_metadata",
      label: "Authorization server metadata response",
      description: "Authorization Server returns metadata",
      from: "authServer",
      to: "client",
      details: flowState.authorizationServerMetadata
        ? [
            {
              label: "Token",
              value: new URL(
                flowState.authorizationServerMetadata.token_endpoint,
              ).pathname,
            },
            {
              label: "Auth",
              value: new URL(
                flowState.authorizationServerMetadata.authorization_endpoint,
              ).pathname,
            },
          ]
        : undefined,
    },
    // CIMD steps
    ...(registrationStrategy === "cimd"
      ? [
          {
            id: "cimd_prepare",
            label: "Client uses HTTPS URL as client_id",
            description:
              "Client prepares to use URL-based client identification",
            from: "client",
            to: "client",
            details: flowState.clientId
              ? [
                  {
                    label: "client_id (URL)",
                    value: flowState.clientId.includes("http")
                      ? flowState.clientId
                      : "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
                  },
                  {
                    label: "Method",
                    value: "Client ID Metadata Document (CIMD)",
                  },
                ]
              : [
                  {
                    label: "Note",
                    value: "HTTPS URL points to metadata document",
                  },
                ],
          },
          {
            id: "cimd_fetch_request",
            label: "Fetch metadata from client_id URL",
            description:
              "Authorization Server fetches client metadata from the URL",
            from: "authServer",
            to: "client",
            details: [
              {
                label: "Action",
                value: "GET client_id URL",
              },
              {
                label: "Note",
                value: "Server initiates metadata fetch during authorization",
              },
            ],
          },
          {
            id: "cimd_metadata_response",
            label: "JSON metadata document",
            description:
              "Client hosting returns metadata with redirect_uris and client info",
            from: "client",
            to: "authServer",
            details: [
              {
                label: "Content-Type",
                value: "application/json",
              },
              {
                label: "Contains",
                value: "client_id, client_name, redirect_uris, etc.",
              },
            ],
          },
          {
            id: "received_client_credentials",
            label: "Validate metadata and redirect_uris",
            description: "Authorization Server validates fetched metadata",
            from: "authServer",
            to: "authServer",
            details: [
              {
                label: "Validates",
                value: "client_id matches URL, redirect_uris are valid",
              },
              {
                label: "Security",
                value: "SSRF protection, domain trust policies",
              },
            ],
          },
        ]
      : registrationStrategy === "dcr"
        ? [
            {
              id: "request_client_registration",
              label: "POST /register (2025-11-25)",
              description:
                "Client registers dynamically with Authorization Server",
              from: "client",
              to: "authServer",
              details: [
                {
                  label: "Note",
                  value: "Dynamic client registration (DCR)",
                },
              ],
            },
            {
              id: "received_client_credentials",
              label: "Client Credentials",
              description:
                "Authorization Server returns client ID and credentials",
              from: "authServer",
              to: "client",
              details: flowState.clientId
                ? [
                    {
                      label: "client_id",
                      value: flowState.clientId.substring(0, 20) + "...",
                    },
                  ]
                : undefined,
            },
          ]
        : [
            {
              id: "received_client_credentials",
              label: "Use Pre-registered Client (2025-11-25)",
              description:
                "Client uses pre-configured credentials (skipped DCR)",
              from: "client",
              to: "client",
              details: flowState.clientId
                ? [
                    {
                      label: "client_id",
                      value: flowState.clientId.substring(0, 20) + "...",
                    },
                    {
                      label: "Note",
                      value: "Pre-registered (no DCR needed)",
                    },
                  ]
                : [
                    {
                      label: "Note",
                      value: "Pre-registered client credentials",
                    },
                  ],
            },
          ]),
    {
      id: "generate_pkce_parameters",
      label: "Generate PKCE (REQUIRED)\nInclude resource parameter",
      description:
        "Client generates code verifier and challenge (REQUIRED), includes resource parameter",
      from: "client",
      to: "client",
      details: flowState.codeChallenge
        ? [
            {
              label: "code_challenge",
              value: flowState.codeChallenge.substring(0, 15) + "...",
            },
            {
              label: "method",
              value: flowState.codeChallengeMethod || "S256",
            },
            {
              label: "resource",
              value: flowState.serverUrl
                ? canonicalizeResourceUrl(flowState.serverUrl)
                : "—",
            },
            { label: "Protocol", value: "2025-11-25" },
          ]
        : undefined,
    },
    {
      id: "authorization_request",
      label: "Open browser with authorization URL",
      description:
        "Client opens browser with authorization URL + code_challenge + resource",
      from: "client",
      to: "browser",
      details: flowState.authorizationUrl
        ? [
            {
              label: "code_challenge",
              value:
                flowState.codeChallenge?.substring(0, 12) + "..." || "S256",
            },
            {
              label: "resource",
              value: flowState.serverUrl
                ? canonicalizeResourceUrl(flowState.serverUrl)
                : "",
            },
          ]
        : undefined,
    },
    {
      id: "browser_to_auth_server",
      label: "Authorization request with resource parameter",
      description: "Browser navigates to authorization endpoint",
      from: "browser",
      to: "authServer",
      details: flowState.authorizationUrl
        ? [{ label: "Note", value: "User authorizes in browser" }]
        : undefined,
    },
    {
      id: "auth_redirect_to_browser",
      label: "Redirect to callback with authorization code",
      description:
        "Authorization Server redirects browser back to callback URL",
      from: "authServer",
      to: "browser",
      details: flowState.authorizationCode
        ? [
            {
              label: "code",
              value: flowState.authorizationCode.substring(0, 20) + "...",
            },
          ]
        : undefined,
    },
    {
      id: "received_authorization_code",
      label: "Authorization code callback",
      description: "Browser redirects back to client with authorization code",
      from: "browser",
      to: "client",
      details: flowState.authorizationCode
        ? [
            {
              label: "code",
              value: flowState.authorizationCode.substring(0, 20) + "...",
            },
          ]
        : undefined,
    },
    {
      id: "token_request",
      label: "Token request + code_verifier + resource",
      description: "Client exchanges authorization code for access token",
      from: "client",
      to: "authServer",
      details: flowState.codeVerifier
        ? [
            { label: "grant_type", value: "authorization_code" },
            {
              label: "resource",
              value: flowState.serverUrl
                ? canonicalizeResourceUrl(flowState.serverUrl)
                : "",
            },
          ]
        : undefined,
    },
    {
      id: "received_access_token",
      label: "Access token (+ refresh token)",
      description: "Authorization Server returns access token",
      from: "authServer",
      to: "client",
      details: flowState.accessToken
        ? [
            { label: "token_type", value: flowState.tokenType || "Bearer" },
            {
              label: "expires_in",
              value: flowState.expiresIn?.toString() || "3600",
            },
          ]
        : undefined,
    },
    {
      id: "authenticated_mcp_request",
      label: "MCP request with access token",
      description: "Client makes authenticated request to MCP server",
      from: "client",
      to: "mcpServer",
      details: flowState.accessToken
        ? [
            { label: "POST", value: "tools/list" },
            {
              label: "Authorization",
              value: "Bearer " + flowState.accessToken.substring(0, 15) + "...",
            },
          ]
        : undefined,
    },
    {
      id: "complete",
      label: "MCP response",
      description: "MCP Server returns successful response",
      from: "mcpServer",
      to: "client",
      details: flowState.accessToken
        ? [
            { label: "Status", value: "200 OK" },
            { label: "Content", value: "tools, resources, prompts" },
          ]
        : undefined,
    },
  ];
}

// Helper: Build authorization server metadata URLs to try (RFC 8414 + OIDC Discovery)
// 2025-11-25 spec: Path insertion first, then path appending (NO root fallback for paths)
function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (url.pathname === "/" || url.pathname === "") {
    // Root path - standard endpoints
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
    );
    urls.push(
      new URL("/.well-known/openid-configuration", url.origin).toString(),
    );
  } else {
    // Path-aware discovery
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // 2025-11-25 spec: OAuth path insertion, OIDC path insertion, OIDC path appending
    // Key difference: NO root fallback
    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `/.well-known/openid-configuration${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `${pathname}/.well-known/openid-configuration`,
        url.origin,
      ).toString(),
    );
  }

  return urls;
}

// Factory function to create the 2025-11-25 state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig,
): OAuthStateMachine => {
  const {
    state: initialState,
    getState,
    updateState,
    serverUrl,
    serverName,
    redirectUrl,
    fetchFn = fetch,
    customScopes,
    customHeaders,
    registrationStrategy = "cimd", // Default to CIMD for 2025-11-25
  } = config;

  // Canonicalize the server URL once at initialization (per RFC 8707)
  const canonicalServerUrl = canonicalizeResourceUrl(serverUrl);

  // Use provided redirectUrl or default to the origin + /oauth/callback/debug
  const redirectUri =
    redirectUrl || `${window.location.origin}/oauth/callback/debug`;

  // Helper to merge custom headers with request headers
  const mergeHeaders = (requestHeaders: Record<string, string> = {}) => {
    return {
      ...customHeaders,
      ...requestHeaders, // Request headers override custom headers
    };
  };

  // Helper to get current state (use getState if provided, otherwise use initial state)
  const getCurrentState = () => (getState ? getState() : initialState);

  // Create machine object that can reference itself
  const machine: OAuthStateMachine = {
    state: initialState,
    updateState,

    // Proceed to next step in the flow (matches SDK's actual approach)
    proceedToNextStep: async () => {
      const state = getCurrentState();

      updateState({ isInitiatingAuth: true });

      try {
        switch (state.currentStep) {
          case "idle":
            // Step 1: Make initial MCP request without token
            const initialRequestHeaders = mergeHeaders({
              "Content-Type": "application/json",
            });

            const initialRequest = {
              method: "POST",
              url: serverUrl,
              headers: initialRequestHeaders,
              body: {
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  clientInfo: {
                    name: "MCPJam Inspector",
                    version: "1.0.0",
                  },
                },
                id: 1,
              },
            };

            // Update state with the request
            updateState({
              currentStep: "request_without_token",
              serverUrl,
              lastRequest: initialRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_without_token",
                  timestamp: Date.now(),
                  request: initialRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_without_token":
            // Step 2: Request MCP server and expect 401 Unauthorized via backend proxy
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            try {
              // Use backend proxy to bypass CORS and capture all headers
              const response = await proxyFetch(state.serverUrl, {
                method: "POST",
                headers: mergeHeaders({
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: {
                      name: "MCPJam Inspector",
                      version: "1.0.0",
                    },
                  },
                  id: 1,
                }),
              });

              // Capture response data for all status codes
              const responseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response and calculate duration
              const updatedHistory = [...(state.httpHistory || [])];
              if (updatedHistory.length > 0) {
                const lastEntry = updatedHistory[updatedHistory.length - 1];
                lastEntry.response = responseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (response.status === 401) {
                // Expected 401 response with WWW-Authenticate header
                const wwwAuthenticateHeader =
                  response.headers["www-authenticate"];

                // Add info log for WWW-Authenticate header
                const infoLogs = wwwAuthenticateHeader
                  ? addInfoLog(
                      state,
                      "received_401_unauthorized",
                      "www-authenticate",
                      "WWW-Authenticate Header",
                      {
                        header: wwwAuthenticateHeader,
                        "Received from": state.serverUrl || "Unknown",
                      },
                    )
                  : state.infoLogs;

                updateState({
                  currentStep: "received_401_unauthorized",
                  wwwAuthenticateHeader: wwwAuthenticateHeader || undefined,
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  infoLogs,
                  isInitiatingAuth: false,
                });
              } else if (response.status === 200) {
                // Server allows anonymous access - try proactive OAuth discovery
                // Add info log explaining optional auth
                const infoLogs = addInfoLog(
                  state,
                  "received_401_unauthorized",
                  "optional-auth",
                  "Optional Authentication Detected",
                  {
                    message: "Server allows anonymous access",
                    note: "Proceeding with OAuth discovery for authenticated features",
                  },
                );

                updateState({
                  currentStep: "received_401_unauthorized", // Reuse the same flow
                  wwwAuthenticateHeader: undefined, // No WWW-Authenticate header
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  infoLogs,
                  isInitiatingAuth: false,
                });
              } else {
                // Unexpected status code - capture response and throw error
                updateState({
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                });
                throw new Error(
                  `Expected 401 Unauthorized but got HTTP ${response.status}: ${response.body?.error?.message || response.statusText}`,
                );
              }
            } catch (error) {
              throw new Error(
                `Failed to request MCP server: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            break;

          case "received_401_unauthorized":
            // Step 3: Extract resource metadata URL and prepare request
            let extractedResourceMetadataUrl: string | undefined;

            if (state.wwwAuthenticateHeader) {
              // Parse WWW-Authenticate header to extract resource_metadata URL
              // Format: Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"
              const resourceMetadataMatch = state.wwwAuthenticateHeader.match(
                /resource_metadata="([^"]+)"/,
              );
              if (resourceMetadataMatch) {
                extractedResourceMetadataUrl = resourceMetadataMatch[1];
              }
            }

            // Fallback to building the URL if not found in header
            if (!extractedResourceMetadataUrl && state.serverUrl) {
              extractedResourceMetadataUrl = buildResourceMetadataUrl(
                state.serverUrl,
              );
            }

            if (!extractedResourceMetadataUrl) {
              throw new Error("Could not determine resource metadata URL");
            }

            const resourceMetadataRequest = {
              method: "GET",
              url: extractedResourceMetadataUrl,
              headers: mergeHeaders({}),
            };

            // Update state with the URL and request
            updateState({
              currentStep: "request_resource_metadata",
              resourceMetadataUrl: extractedResourceMetadataUrl,
              lastRequest: resourceMetadataRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_resource_metadata",
                  timestamp: Date.now(),
                  request: resourceMetadataRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_resource_metadata":
            // Step 2: Fetch and parse resource metadata using official SDK helper
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            const historyWithoutPlaceholder = [...(state.httpHistory || [])];
            let pendingHistoryEntry =
              historyWithoutPlaceholder.length > 0 &&
              historyWithoutPlaceholder[historyWithoutPlaceholder.length - 1]
                ?.step === "request_resource_metadata" &&
              !historyWithoutPlaceholder[historyWithoutPlaceholder.length - 1]
                ?.response
                ? historyWithoutPlaceholder.pop()
                : undefined;

            const attempts: HttpHistoryEntry[] = [];

            const normalizeHeaders = (
              headers?: HeadersInit,
            ): Record<string, string> => {
              if (!headers) return {};
              if (headers instanceof Headers) {
                return Object.fromEntries(headers.entries());
              }
              if (Array.isArray(headers)) {
                return Object.fromEntries(headers);
              }
              return Object.fromEntries(
                Object.entries(headers).map(([key, value]) => [
                  key,
                  String(value),
                ]),
              );
            };

            const loggingFetch: typeof fetch = async (url, init = {}) => {
              const requestUrl = typeof url === "string" ? url : url.toString();
              const mergedHeaders = mergeHeaders(
                normalizeHeaders(init.headers as HeadersInit | undefined),
              );

              const historyEntry: HttpHistoryEntry = pendingHistoryEntry
                ? {
                    ...pendingHistoryEntry,
                    timestamp: Date.now(),
                    request: {
                      method: init.method || "GET",
                      url: requestUrl,
                      headers: mergedHeaders,
                      body: init.body,
                    },
                  }
                : {
                    step: "request_resource_metadata",
                    timestamp: Date.now(),
                    request: {
                      method: init.method || "GET",
                      url: requestUrl,
                      headers: mergedHeaders,
                      body: init.body,
                    },
                  };

              pendingHistoryEntry = undefined;
              attempts.push(historyEntry);

              try {
                const response = await proxyFetch(requestUrl, {
                  method: init.method || "GET",
                  headers: mergedHeaders,
                  body: init.body as any,
                });

                historyEntry.response = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.body,
                };
                historyEntry.duration = Date.now() - historyEntry.timestamp;

                const responseInit: ResponseInit = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                };
                const responseBody =
                  typeof response.body === "string"
                    ? response.body
                    : JSON.stringify(response.body ?? {});
                return new Response(responseBody, responseInit);
              } catch (fetchError) {
                historyEntry.error = toLogErrorDetails(fetchError);
                historyEntry.duration = Date.now() - historyEntry.timestamp;
                throw fetchError;
              }
            };

            try {
              const metadataOptions =
                state.wwwAuthenticateHeader && state.resourceMetadataUrl
                  ? { resourceMetadataUrl: state.resourceMetadataUrl }
                  : undefined;

              const resourceMetadata =
                await discoverOAuthProtectedResourceMetadata(
                  state.serverUrl,
                  metadataOptions,
                  loggingFetch,
                );

              const finalHistory = [...historyWithoutPlaceholder, ...attempts];

              const lastAttempt = attempts[attempts.length - 1];
              const authorizationServerUrl =
                resourceMetadata.authorization_servers?.[0] || serverUrl;

              // Add info log for Authorization Servers
              const infoLogs = addInfoLog(
                state,
                "received_resource_metadata",
                "authorization-servers",
                "Authorization Servers",
                {
                  Resource: resourceMetadata.resource,
                  "Authorization Servers":
                    resourceMetadata.authorization_servers,
                },
              );

              updateState({
                currentStep: "received_resource_metadata",
                resourceMetadata,
                resourceMetadataUrl:
                  lastAttempt?.request?.url || state.resourceMetadataUrl,
                authorizationServerUrl,
                lastRequest: lastAttempt?.request,
                lastResponse: lastAttempt?.response,
                httpHistory: finalHistory,
                infoLogs,
                isInitiatingAuth: false,
              });
            } catch (error) {
              const updatedHistory = markLatestHttpEntryAsError(
                [...historyWithoutPlaceholder, ...attempts],
                toLogErrorDetails(error),
              );

              updateState({
                lastResponse: attempts[attempts.length - 1]?.response,
                httpHistory: updatedHistory,
              });

              throw new Error(
                `Failed to request resource metadata: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            break;

          case "received_resource_metadata":
            // Step 3: Request Authorization Server Metadata
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const authServerUrls = buildAuthServerMetadataUrls(
              state.authorizationServerUrl,
            );

            const authServerRequest = {
              method: "GET",
              url: authServerUrls[0], // Show the first URL we'll try
              headers: mergeHeaders({}),
            };

            // Update state with the request
            updateState({
              currentStep: "request_authorization_server_metadata",
              lastRequest: authServerRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_authorization_server_metadata",
                  timestamp: Date.now(),
                  request: authServerRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_authorization_server_metadata":
            // Step 4: Fetch authorization server metadata (try multiple endpoints) via backend proxy
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const urlsToTry = buildAuthServerMetadataUrls(
              state.authorizationServerUrl,
            );
            let authServerMetadata = null;
            let lastError = null;
            let successUrl = "";
            let finalRequestHeaders = {};
            let finalResponseHeaders: Record<string, string> = {};
            let finalResponseData: any = null;

            for (const url of urlsToTry) {
              try {
                const requestHeaders = mergeHeaders({});

                // Update request URL as we try different endpoints
                const updatedHistoryForRetry = [...(state.httpHistory || [])];
                if (updatedHistoryForRetry.length > 0) {
                  updatedHistoryForRetry[
                    updatedHistoryForRetry.length - 1
                  ].request = {
                    method: "GET",
                    url: url,
                    headers: requestHeaders,
                  };
                }

                updateState({
                  lastRequest: {
                    method: "GET",
                    url: url,
                    headers: requestHeaders,
                  },
                  httpHistory: updatedHistoryForRetry,
                });

                // Use backend proxy to bypass CORS
                const response = await proxyFetch(url, {
                  method: "GET",
                  headers: mergeHeaders({}),
                });

                if (response.ok) {
                  authServerMetadata = response.body;
                  successUrl = url;
                  finalRequestHeaders = requestHeaders;
                  finalResponseHeaders = response.headers;
                  finalResponseData = response;

                  break;
                } else if (response.status >= 400 && response.status < 500) {
                  // Client error, try next URL
                  continue;
                } else {
                  // Server error, might be temporary
                  lastError = new Error(`HTTP ${response.status} from ${url}`);
                }
              } catch (error) {
                lastError = error;
                continue;
              }
            }

            if (!authServerMetadata || !finalResponseData) {
              throw new Error(
                `Could not discover authorization server metadata. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
              );
            }

            // Validate required AS metadata fields per RFC 8414
            if (!authServerMetadata.issuer) {
              throw new Error(
                "Authorization server metadata missing required 'issuer' field",
              );
            }
            if (!authServerMetadata.authorization_endpoint) {
              throw new Error(
                "Authorization server metadata missing 'authorization_endpoint'",
              );
            }
            if (!authServerMetadata.token_endpoint) {
              throw new Error(
                "Authorization server metadata missing 'token_endpoint'",
              );
            }
            if (
              !authServerMetadata.response_types_supported?.includes("code")
            ) {
              throw new Error(
                "Authorization server does not support 'code' response type",
              );
            }

            const authServerResponseData = {
              status: finalResponseData.status,
              statusText: finalResponseData.statusText,
              headers: finalResponseHeaders,
              body: authServerMetadata,
            };

            // Update the last history entry with the response
            const updatedHistoryFinal = [...(state.httpHistory || [])];
            if (updatedHistoryFinal.length > 0) {
              const lastEntry =
                updatedHistoryFinal[updatedHistoryFinal.length - 1];
              lastEntry.response = authServerResponseData;
              lastEntry.duration =
                Date.now() - (lastEntry.timestamp || Date.now());
            }

            // Validate PKCE support (REQUIRED for 2025-11-25)
            const supportedMethods =
              authServerMetadata.code_challenge_methods_supported || [];

            // 2025-11-25 spec: MUST verify PKCE support
            if (!supportedMethods || supportedMethods.length === 0) {
              throw new Error(
                "PKCE is REQUIRED for 2025-11-25 protocol, but authorization server " +
                  "does not advertise code_challenge_methods_supported. " +
                  "Server is not compliant with 2025-11-25 spec.",
              );
            }

            // Add info log for Authorization Server Metadata
            const metadata: Record<string, any> = {
              Issuer: authServerMetadata.issuer,
              "Authorization Endpoint":
                authServerMetadata.authorization_endpoint,
              "Token Endpoint": authServerMetadata.token_endpoint,
            };

            if (authServerMetadata.registration_endpoint) {
              metadata["Registration Endpoint"] =
                authServerMetadata.registration_endpoint;
            }
            if (authServerMetadata.code_challenge_methods_supported) {
              metadata["PKCE Methods"] =
                authServerMetadata.code_challenge_methods_supported;
            }
            if (authServerMetadata.grant_types_supported) {
              metadata["Grant Types"] =
                authServerMetadata.grant_types_supported;
            }
            if (authServerMetadata.response_types_supported) {
              metadata["Response Types"] =
                authServerMetadata.response_types_supported;
            }
            if (authServerMetadata.scopes_supported) {
              metadata["Scopes"] = authServerMetadata.scopes_supported;
            }

            const infoLogs = addInfoLog(
              getCurrentState(),
              "received_authorization_server_metadata",
              "as-metadata",
              "Authorization Server Metadata",
              metadata,
            );

            if (!supportedMethods.includes("S256")) {
              console.warn(
                "Authorization server may not support S256 PKCE method. Supported methods:",
                supportedMethods,
              );
              // Add warning to state but continue
              updateState({
                currentStep: "received_authorization_server_metadata",
                authorizationServerMetadata: authServerMetadata,
                lastResponse: authServerResponseData,
                httpHistory: updatedHistoryFinal,
                infoLogs,
                error:
                  "Warning: Authorization server may not support S256 PKCE method",
                isInitiatingAuth: false,
              });
            } else {
              updateState({
                currentStep: "received_authorization_server_metadata",
                authorizationServerMetadata: authServerMetadata,
                lastResponse: authServerResponseData,
                httpHistory: updatedHistoryFinal,
                infoLogs,
                isInitiatingAuth: false,
              });
            }
            break;

          case "received_authorization_server_metadata":
            // Step 5: Client Registration (CIMD > Pre-registered > DCR)
            if (!state.authorizationServerMetadata) {
              throw new Error("No authorization server metadata available");
            }

            // Check registration strategy - 2025-11-25 priority: CIMD > Pre-registered > DCR
            if (registrationStrategy === "cimd") {
              // CIMD Step 1: Prepare client_id URL
              updateState({
                currentStep: "cimd_prepare",
                clientId: MCPJAM_CLIENT_ID,
                isInitiatingAuth: false,
              });

              // Auto-proceed to next step
              setTimeout(() => machine.proceedToNextStep(), 800);
              return;
            } else if (registrationStrategy === "preregistered") {
              // Skip DCR - load pre-registered client credentials from localStorage
              const { clientId, clientSecret } =
                loadPreregisteredCredentials(serverName);

              if (!clientId) {
                updateState({
                  error:
                    "Pre-registered client ID is required. Please configure OAuth credentials in the server settings.",
                  isInitiatingAuth: false,
                });
                return;
              }

              // Add info log for pre-registered client
              const preregInfo: Record<string, any> = {
                "Client ID": clientId,
                "Client Secret": clientSecret
                  ? "Configured"
                  : "Not provided (public client)",
                "Token Auth Method": clientSecret
                  ? "client_secret_post"
                  : "none",
                Note: "Using pre-registered client credentials from server config (skipped DCR)",
              };

              const infoLogs = addInfoLog(
                getCurrentState(),
                "received_client_credentials",
                "dcr",
                "Pre-registered Client",
                preregInfo,
              );

              updateState({
                currentStep: "received_client_credentials",
                clientId,
                clientSecret: clientSecret || undefined,
                tokenEndpointAuthMethod: clientSecret
                  ? "client_secret_post"
                  : "none",
                infoLogs,
                isInitiatingAuth: false,
              });
            } else if (
              state.authorizationServerMetadata.registration_endpoint
            ) {
              // Dynamic Client Registration (DCR)
              // Prepare client metadata with scopes if available
              const scopesSupported =
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported;

              const clientMetadata: Record<string, any> = {
                client_name: "MCPJam Inspector Debug Client",
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none", // Public client (no client secret)
              };

              // Include scopes if supported by the server
              if (scopesSupported && scopesSupported.length > 0) {
                clientMetadata.scope = scopesSupported.join(" ");
              }

              const registrationRequest = {
                method: "POST",
                url: state.authorizationServerMetadata.registration_endpoint,
                headers: mergeHeaders({
                  "Content-Type": "application/json",
                }),
                body: clientMetadata,
              };

              // Update state with the request
              updateState({
                currentStep: "request_client_registration",
                lastRequest: registrationRequest,
                lastResponse: undefined,
                httpHistory: [
                  ...(state.httpHistory || []),
                  {
                    step: "request_client_registration",
                    timestamp: Date.now(),
                    request: registrationRequest,
                  },
                ],
                isInitiatingAuth: false,
              });

              // Automatically proceed to make the actual request
              setTimeout(() => machine.proceedToNextStep(), 50);
              return;
            } else {
              // No registration endpoint and DCR strategy - skip to PKCE generation with a mock client ID
              updateState({
                currentStep: "generate_pkce_parameters",
                clientId: "mock-client-id-for-demo",
                tokenEndpointAuthMethod: "none", // Public client
                isInitiatingAuth: false,
              });
            }
            break;

          case "request_client_registration":
            // Step 6: Dynamic Client Registration (RFC 7591)
            if (!state.authorizationServerMetadata?.registration_endpoint) {
              throw new Error("No registration endpoint available");
            }

            if (!state.lastRequest?.body) {
              throw new Error("No client metadata in request");
            }

            try {
              // Make actual POST request to registration endpoint via backend proxy
              const response = await proxyFetch(
                state.authorizationServerMetadata.registration_endpoint,
                {
                  method: "POST",
                  headers: mergeHeaders({
                    "Content-Type": "application/json",
                  }),
                  body: JSON.stringify(state.lastRequest.body),
                },
              );

              const registrationResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response
              const updatedHistoryReg = [...(state.httpHistory || [])];
              if (updatedHistoryReg.length > 0) {
                const lastEntry =
                  updatedHistoryReg[updatedHistoryReg.length - 1];
                lastEntry.response = registrationResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                // Registration failed - could be server doesn't support DCR or request was invalid

                // Update state with error but continue with fallback
                updateState({
                  lastResponse: registrationResponseData,
                  httpHistory: updatedHistoryReg,
                  error: `Dynamic Client Registration failed (${response.status}). Using fallback client ID.`,
                });

                // Fall back to mock client ID (simulating preregistered client)
                const fallbackClientId = "preregistered-client-id";

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: fallbackClientId,
                  clientSecret: undefined,
                  tokenEndpointAuthMethod: "none", // Assume public client
                  isInitiatingAuth: false,
                });
              } else {
                // Registration successful
                const clientInfo = response.body;

                // Add info log for DCR
                const dcrInfo: Record<string, any> = {
                  "Client ID": clientInfo.client_id,
                  "Client Name": clientInfo.client_name,
                  "Token Auth Method":
                    clientInfo.token_endpoint_auth_method || "none",
                  "Redirect URIs": clientInfo.redirect_uris,
                  "Grant Types": clientInfo.grant_types,
                  "Response Types": clientInfo.response_types,
                };

                if (clientInfo.client_secret) {
                  dcrInfo["Client Secret"] =
                    clientInfo.client_secret.substring(0, 20) + "...";
                  dcrInfo["Note"] =
                    "Server issued client_secret - this will be used in token requests";
                }

                const infoLogs = addInfoLog(
                  getCurrentState(),
                  "received_client_credentials",
                  "dcr",
                  "Dynamic Client Registration",
                  dcrInfo,
                );

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: clientInfo.client_id,
                  clientSecret: clientInfo.client_secret,
                  tokenEndpointAuthMethod:
                    clientInfo.token_endpoint_auth_method || "none",
                  lastResponse: registrationResponseData,
                  httpHistory: updatedHistoryReg,
                  infoLogs,
                  error: undefined,
                  isInitiatingAuth: false,
                });
              }
            } catch (error) {
              // Capture the error but continue with fallback
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: mergeHeaders({}),
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry =
                  updatedHistoryError[updatedHistoryError.length - 1];
                lastEntry.response = errorResponse;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Client registration failed: ${error instanceof Error ? error.message : String(error)}. Using fallback.`,
              });

              // Fall back to mock client ID
              const fallbackClientId = "preregistered-client-id";

              updateState({
                currentStep: "received_client_credentials",
                clientId: fallbackClientId,
                clientSecret: undefined,
                tokenEndpointAuthMethod: "none", // Assume public client
                isInitiatingAuth: false,
              });
            }
            break;

          case "cimd_prepare":
            // CIMD Step 2: Simulate server detecting URL-formatted client_id and fetching metadata
            updateState({
              currentStep: "cimd_fetch_request",
              isInitiatingAuth: false,
            });

            // Auto-proceed to next step
            setTimeout(() => machine.proceedToNextStep(), 800);
            return;

          case "cimd_fetch_request":
            // CIMD Step 3: Fetch and validate the CIMD document
            const cimdSupported = (state.authorizationServerMetadata as any)
              ?.client_id_metadata_document_supported;

            try {
              // Fetch the CIMD document (simulating what the auth server does)
              const cimdResponse = await proxyFetch(MCPJAM_CLIENT_ID, {
                method: "GET",
              });

              if (!cimdResponse.ok) {
                throw new Error(
                  `CIMD endpoint returned HTTP ${cimdResponse.status}`,
                );
              }

              const cimdDoc = cimdResponse.body;

              // Store metadata for next step
              updateState({
                currentStep: "cimd_metadata_response",
                isInitiatingAuth: false,
              });

              // Auto-proceed to validation step
              setTimeout(() => machine.proceedToNextStep(), 800);
              return;
            } catch (error) {
              updateState({
                error:
                  `CIMD metadata fetch failed: ${error instanceof Error ? error.message : String(error)}. ` +
                  "Try using 'dcr' or 'preregistered' registration strategy instead.",
                isInitiatingAuth: false,
              });
              return;
            }

          case "cimd_metadata_response":
            // CIMD Step 4: Validate the fetched metadata and complete registration
            try {
              // Re-fetch to validate
              const cimdResponse = await proxyFetch(MCPJAM_CLIENT_ID, {
                method: "GET",
              });

              if (!cimdResponse.ok) {
                throw new Error(
                  `CIMD endpoint returned HTTP ${cimdResponse.status}`,
                );
              }

              const cimdDoc = cimdResponse.body;

              // Validate CIMD document
              if (cimdDoc.client_id !== MCPJAM_CLIENT_ID) {
                throw new Error("CIMD client_id mismatch");
              }

              // Add info log for CIMD validation
              const cimdSupported = (state.authorizationServerMetadata as any)
                ?.client_id_metadata_document_supported;

              const cimdInfo: Record<string, any> = {
                "Client ID": MCPJAM_CLIENT_ID,
                "Registration Method": "Client ID Metadata Document (CIMD)",
                "Client Name": cimdDoc.client_name || "MCPJam",
                "Redirect URIs": cimdDoc.redirect_uris || [],
                "Token Auth Method":
                  cimdDoc.token_endpoint_auth_method || "none",
                Validation: "✓ Metadata fetched and validated",
                Note: "Server fetched and validated client metadata from URL",
              };

              if (cimdSupported) {
                cimdInfo["Server Support"] =
                  "✓ Advertised in metadata (client_id_metadata_document_supported: true)";
              } else {
                cimdInfo["Server Support"] =
                  "⚠ Not advertised (attempting anyway)";
              }

              const infoLogs = addInfoLog(
                getCurrentState(),
                "received_client_credentials",
                "cimd",
                "Client ID Metadata Document",
                cimdInfo,
              );

              updateState({
                currentStep: "received_client_credentials",
                clientId: MCPJAM_CLIENT_ID,
                clientSecret: undefined, // Public client with CIMD
                tokenEndpointAuthMethod: "none",
                infoLogs,
                isInitiatingAuth: false,
              });
            } catch (error) {
              updateState({
                error:
                  `CIMD validation failed: ${error instanceof Error ? error.message : String(error)}. ` +
                  "Try using 'dcr' or 'preregistered' registration strategy instead.",
                isInitiatingAuth: false,
              });
              return;
            }
            break;

          case "received_client_credentials":
            // Step 7: Generate PKCE parameters

            // Generate PKCE parameters (simplified for demo)
            const codeVerifier = generateRandomString(43);
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            // Add info log for PKCE parameters
            const pkceInfoLogs = addInfoLog(
              getCurrentState(),
              "generate_pkce_parameters",
              "pkce-generation",
              "Generate PKCE Parameters",
              {
                code_challenge: codeChallenge,
                method: "S256",
                resource: canonicalServerUrl,
              },
            );

            updateState({
              currentStep: "generate_pkce_parameters",
              codeVerifier,
              codeChallenge,
              codeChallengeMethod: "S256",
              state: generateRandomString(16),
              infoLogs: pkceInfoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "generate_pkce_parameters":
            // Step 8: Build authorization URL
            if (
              !state.authorizationServerMetadata?.authorization_endpoint ||
              !state.clientId
            ) {
              throw new Error("Missing authorization endpoint or client ID");
            }

            const authUrl = new URL(
              state.authorizationServerMetadata.authorization_endpoint,
            );
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", state.clientId);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set(
              "code_challenge",
              state.codeChallenge || "",
            );
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("state", state.state || "");
            authUrl.searchParams.set("resource", canonicalServerUrl);

            // Add scopes to request refresh tokens and other capabilities
            // If custom scopes are provided, use them exclusively
            if (customScopes) {
              authUrl.searchParams.set("scope", customScopes);
            } else {
              // Otherwise, use automatic scope discovery
              const scopesSupported =
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported;

              // Build scope string using only server-advertised scopes
              const scopes = new Set<string>();

              // Add all server-advertised scopes (MCP-specific, OIDC, or other)
              // This ensures we only request scopes the server explicitly supports
              if (scopesSupported && scopesSupported.length > 0) {
                scopesSupported.forEach((scope) => scopes.add(scope));
              }

              // Set scope parameter - use only scopes the server actually supports
              if (scopes.size > 0) {
                authUrl.searchParams.set("scope", Array.from(scopes).join(" "));
              }
            }

            // Add info log for Authorization URL
            const authUrlInfoLogs = addInfoLog(
              getCurrentState(),
              "authorization_request",
              "auth-url",
              "Authorization URL",
              {
                url: authUrl.toString(),
              },
            );

            updateState({
              currentStep: "authorization_request",
              authorizationUrl: authUrl.toString(),
              authorizationCode: undefined, // Clear any old authorization code
              accessToken: undefined, // Clear any old tokens
              refreshToken: undefined,
              tokenType: undefined,
              expiresIn: undefined,
              infoLogs: authUrlInfoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "authorization_request":
            // Step 9: Authorization URL is ready - user should open it in browser

            // Move to the next step where user can enter the authorization code
            updateState({
              currentStep: "received_authorization_code",
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_code":
            // Step 10: Validate authorization code and prepare for token exchange

            if (
              !state.authorizationCode ||
              state.authorizationCode.trim() === ""
            ) {
              updateState({
                error:
                  "Authorization code is required. Please paste the code you received from the authorization server.",
                isInitiatingAuth: false,
              });
              return;
            }

            if (!state.authorizationServerMetadata?.token_endpoint) {
              throw new Error("Missing token endpoint");
            }

            // Build the token request body as an object (will be shown in HTTP history)
            const tokenRequestBodyObj: Record<string, string> = {
              grant_type: "authorization_code",
              code: state.authorizationCode,
              redirect_uri: redirectUri,
            };

            if (state.clientId) {
              tokenRequestBodyObj.client_id = state.clientId;
            }

            if (state.clientSecret) {
              tokenRequestBodyObj.client_secret = state.clientSecret;
            }

            if (state.codeVerifier) {
              tokenRequestBodyObj.code_verifier = state.codeVerifier;
            }

            tokenRequestBodyObj.resource = canonicalServerUrl;

            const tokenRequest = {
              method: "POST",
              url: state.authorizationServerMetadata.token_endpoint,
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: tokenRequestBodyObj,
            };

            // Update state with the request (clear old tokens)
            updateState({
              currentStep: "token_request",
              lastRequest: tokenRequest,
              lastResponse: undefined,
              accessToken: undefined, // Clear old token
              refreshToken: undefined, // Clear old refresh token
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "token_request",
                  timestamp: Date.now(),
                  request: tokenRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "token_request":
            // Step 11: Exchange authorization code for access token
            if (!state.authorizationServerMetadata?.token_endpoint) {
              throw new Error("Missing token endpoint");
            }

            if (!state.authorizationCode) {
              throw new Error("Missing authorization code");
            }

            if (!state.codeVerifier) {
              throw new Error(
                "PKCE code_verifier is missing - cannot exchange token",
              );
            }

            try {
              // Prepare token request body (form-urlencoded)
              const tokenRequestBody = new URLSearchParams({
                grant_type: "authorization_code",
                code: state.authorizationCode,
                redirect_uri: redirectUri,
                client_id: state.clientId || "",
                code_verifier: state.codeVerifier || "",
              });

              // Add client_secret if available (for confidential clients)
              if (state.clientSecret) {
                tokenRequestBody.set("client_secret", state.clientSecret);
              }

              // Add resource parameter (canonicalized per RFC 8707)
              tokenRequestBody.set("resource", canonicalServerUrl);

              // Make the token request via backend proxy
              const response = await proxyFetch(
                state.authorizationServerMetadata.token_endpoint,
                {
                  method: "POST",
                  headers: mergeHeaders({
                    "Content-Type": "application/x-www-form-urlencoded",
                  }),
                  body: tokenRequestBody.toString(),
                },
              );

              const tokenResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response
              const updatedHistoryToken = [...(state.httpHistory || [])];
              if (updatedHistoryToken.length > 0) {
                const lastEntry =
                  updatedHistoryToken[updatedHistoryToken.length - 1];
                lastEntry.response = tokenResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                // Token request failed
                updateState({
                  lastResponse: tokenResponseData,
                  httpHistory: updatedHistoryToken,
                  // Clear the authorization code so it won't be retried
                  authorizationCode: undefined,
                  error: `Token request failed: ${response.body?.error || response.statusText} - ${response.body?.error_description || "Unknown error"}`,
                  isInitiatingAuth: false,
                });
                return;
              }

              // Token request successful
              const tokens = response.body;

              // Start with existing logs, filtering out any token-related logs we're about to add
              // to prevent duplicates
              const existingLogs = (getCurrentState().infoLogs || []).filter(
                (log) =>
                  log.id !== "auth-code" &&
                  log.id !== "oauth-tokens" &&
                  log.id !== "token",
              );

              let tokenInfoLogs = existingLogs;

              // Add Authorization Code log
              if (state.authorizationCode) {
                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "auth-code",
                    level: "info",
                    step: "authorization_request",
                    label: "Authorization Code",
                    data: {
                      code: state.authorizationCode,
                    },
                    timestamp: Date.now(),
                  },
                ];
              }

              if (tokens.access_token) {
                const tokenData: Record<string, any> = {
                  access_token: tokens.access_token,
                };

                if (tokens.refresh_token) {
                  tokenData.refresh_token = tokens.refresh_token;
                }

                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "oauth-tokens",
                    level: "info",
                    step: "token_request",
                    label: "OAuth Tokens",
                    data: tokenData,
                    timestamp: Date.now(),
                  },
                ];
              }

              // Decode and add access token JWT log
              if (tokens.access_token) {
                const decoded = decodeJWT(tokens.access_token);
                if (decoded) {
                  const formatted = { ...decoded };
                  // Format timestamp fields
                  if (formatted.exp) {
                    formatted.exp = `${formatted.exp} (${formatJWTTimestamp(formatted.exp)})`;
                  }
                  if (formatted.iat) {
                    formatted.iat = `${formatted.iat} (${formatJWTTimestamp(formatted.iat)})`;
                  }
                  if (formatted.nbf) {
                    formatted.nbf = `${formatted.nbf} (${formatJWTTimestamp(formatted.nbf)})`;
                  }

                  // Add audience validation note
                  const audienceNote: Record<string, any> = {
                    ...formatted,
                  };

                  // Check if audience claim exists and validate it
                  if (formatted.aud) {
                    const expectedResource = state.serverUrl;
                    const audArray = Array.isArray(formatted.aud)
                      ? formatted.aud
                      : [formatted.aud];

                    const isValidAudience = audArray.some(
                      (aud: string) => aud === expectedResource,
                    );

                    audienceNote._validation = {
                      expected_audience: expectedResource,
                      audience_matches: isValidAudience,
                      note: isValidAudience
                        ? "✓ Token audience matches MCP server"
                        : "⚠ Token audience does not match MCP server (security risk)",
                    };
                  } else {
                    audienceNote._validation = {
                      note: "⚠ No audience claim found - server should validate token binding",
                    };
                  }

                  tokenInfoLogs = [
                    ...tokenInfoLogs,
                    {
                      id: "token",
                      level: "info",
                      step: "token_request",
                      label: "Access Token (Decoded JWT)",
                      data: audienceNote,
                      timestamp: Date.now(),
                    },
                  ];
                }
              }

              // Decode and add ID token JWT log (OIDC flows)
              if (tokens.id_token) {
                const decodedIdToken = decodeJWT(tokens.id_token);
                if (decodedIdToken) {
                  const formattedIdToken = { ...decodedIdToken };
                  // Format timestamp fields
                  if (formattedIdToken.exp) {
                    formattedIdToken.exp = `${formattedIdToken.exp} (${formatJWTTimestamp(formattedIdToken.exp)})`;
                  }
                  if (formattedIdToken.iat) {
                    formattedIdToken.iat = `${formattedIdToken.iat} (${formatJWTTimestamp(formattedIdToken.iat)})`;
                  }
                  if (formattedIdToken.nbf) {
                    formattedIdToken.nbf = `${formattedIdToken.nbf} (${formatJWTTimestamp(formattedIdToken.nbf)})`;
                  }
                  if (formattedIdToken.auth_time) {
                    formattedIdToken.auth_time = `${formattedIdToken.auth_time} (${formatJWTTimestamp(formattedIdToken.auth_time)})`;
                  }

                  // Add OIDC-specific validation note
                  formattedIdToken._note =
                    "OIDC ID Token - Used for user identity verification";

                  tokenInfoLogs = [
                    ...tokenInfoLogs,
                    {
                      id: "id-token",
                      level: "info",
                      step: "token_request",
                      label: "ID Token (OIDC - Decoded JWT)",
                      data: formattedIdToken,
                      timestamp: Date.now(),
                    },
                  ];
                }
              }

              updateState({
                currentStep: "received_access_token",
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                tokenType: tokens.token_type || "Bearer",
                expiresIn: tokens.expires_in,
                lastResponse: tokenResponseData,
                httpHistory: updatedHistoryToken,
                infoLogs: tokenInfoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            } catch (error) {
              // Capture the error
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: mergeHeaders({}),
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry =
                  updatedHistoryError[updatedHistoryError.length - 1];
                lastEntry.response = errorResponse;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
                isInitiatingAuth: false,
              });
            }
            break;

          case "received_access_token":
            // Step 12: Make authenticated MCP request (initialize to establish session)
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            const authenticatedRequest = {
              method: "POST",
              url: state.serverUrl,
              headers: {
                Authorization: `Bearer ${state.accessToken}`,
                "Content-Type": "application/json",
                "MCP-Protocol-Version": "2025-11-25",
              },
              body: {
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  clientInfo: {
                    name: "MCPJam Inspector",
                    version: "1.0.0",
                  },
                },
                id: 2,
              },
            };

            // Add info log for authenticated initialize request
            const authenticatedRequestInfoLogs = addInfoLog(
              getCurrentState(),
              "authenticated_mcp_request",
              "authenticated-init",
              "Authenticated MCP Initialize Request",
              {
                Request: "MCP initialize with OAuth bearer token",
                "Protocol Version": "2025-11-25",
                Client: "MCPJam Inspector v1.0.0",
                Endpoint: state.serverUrl,
              },
            );

            // Update state with the request
            updateState({
              currentStep: "authenticated_mcp_request",
              lastRequest: authenticatedRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "authenticated_mcp_request",
                  timestamp: Date.now(),
                  request: authenticatedRequest,
                },
              ],
              infoLogs: authenticatedRequestInfoLogs,
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "authenticated_mcp_request":
            // Step 13: Make actual authenticated request to verify token (initialize with auth)
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            try {
              const response = await proxyFetch(state.serverUrl, {
                method: "POST",
                headers: mergeHeaders({
                  Authorization: `Bearer ${state.accessToken}`,
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: {
                      name: "MCPJam Inspector",
                      version: "1.0.0",
                    },
                  },
                  id: 2,
                }),
              });

              const mcpResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response
              const updatedHistoryMcp = [...(state.httpHistory || [])];
              if (updatedHistoryMcp.length > 0) {
                const lastEntry =
                  updatedHistoryMcp[updatedHistoryMcp.length - 1];
                lastEntry.response = mcpResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                updateState({
                  lastResponse: mcpResponseData,
                  httpHistory: updatedHistoryMcp,
                  error: `Authenticated request failed: ${response.status} ${response.statusText}`,
                  isInitiatingAuth: false,
                });
                return;
              }

              // Add info log for MCP protocol version
              let mcpInfoLogs = getCurrentState().infoLogs || [];

              // Check if response is SSE (Streamable HTTP transport)
              const contentType = response.headers["content-type"] || "";
              const isSSE = contentType.includes("text/event-stream");

              // Extract MCP response from body (could be direct JSON or parsed SSE)
              let mcpResponse = null;
              // Handle structured SSE response from debug proxy
              if (isSSE && response.body?.transport === "sse") {
                // SSE response - extract MCP response from parsed events
                mcpResponse = response.body.mcpResponse;
              } else {
                // Direct JSON response
                mcpResponse = response.body;
              }

              if (isSSE && mcpResponse?.result?.protocolVersion) {
                // SSE streaming response with parsed MCP response
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "Server-Sent Events (streaming)",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                // Include server info if available
                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

                // Include capabilities if available
                if (mcpResponse.result.capabilities) {
                  protocolInfo["Capabilities"] =
                    mcpResponse.result.capabilities;
                }

                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-protocol",
                  "MCP Server Information",
                  protocolInfo,
                );
              } else if (isSSE) {
                // SSE streaming response but no MCP response parsed yet
                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-transport",
                  "MCP Transport Detected",
                  {
                    Transport: "Streamable HTTP",
                    "Response Format": "Server-Sent Events (streaming)",
                    "Content-Type": contentType,
                    Note: "Server returned streaming response. Initialize response delivered via SSE stream.",
                    Events: response.body?.events
                      ? `${response.body.events.length} events parsed`
                      : "No events parsed",
                  },
                );
              } else if (mcpResponse?.result?.protocolVersion) {
                // JSON response - extract protocol version from response body
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "JSON",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                // Include server info if available
                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

                // Include capabilities if available
                if (mcpResponse.result.capabilities) {
                  protocolInfo["Capabilities"] =
                    mcpResponse.result.capabilities;
                }

                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-protocol",
                  "MCP Server Information",
                  protocolInfo,
                );
              }

              updateState({
                currentStep: "complete",
                lastResponse: mcpResponseData,
                httpHistory: updatedHistoryMcp,
                infoLogs: mcpInfoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            } catch (error) {
              // Capture the error
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: mergeHeaders({}),
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry =
                  updatedHistoryError[updatedHistoryError.length - 1];
                lastEntry.response = errorResponse;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Authenticated MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
                isInitiatingAuth: false,
              });
            }
            break;

          case "complete":
            // Terminal state
            updateState({ isInitiatingAuth: false });
            break;

          default:
            updateState({ isInitiatingAuth: false });
            break;
        }
      } catch (error) {
        const currentState = getCurrentState();
        const errorDetails = toLogErrorDetails(error);
        const infoLogs = addInfoLog(
          currentState,
          currentState.currentStep,
          `error-${currentState.currentStep}-${Date.now()}`,
          "Step failed",
          {
            step: currentState.currentStep,
            request: currentState.lastRequest,
            response: currentState.lastResponse,
            error: errorDetails,
          },
          { level: "error", error: errorDetails },
        );
        const updatedHistory = markLatestHttpEntryAsError(
          currentState.httpHistory,
          errorDetails,
        );

        const updates: Partial<OAuthFlowState> = {
          error: errorDetails.message,
          infoLogs,
          isInitiatingAuth: false,
        };

        if (updatedHistory) {
          updates.httpHistory = updatedHistory;
        }

        updateState(updates);
      }
    },

    // Start the guided flow from the beginning
    startGuidedFlow: async () => {
      updateState({
        currentStep: "idle",
        isInitiatingAuth: false,
      });
    },

    // Reset the flow to initial state
    resetFlow: () => {
      updateState({
        ...EMPTY_OAUTH_FLOW_STATE_V2,
        lastRequest: undefined,
        lastResponse: undefined,
        httpHistory: [],
        infoLogs: [],
        authorizationCode: undefined,
        authorizationUrl: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        codeVerifier: undefined,
        codeChallenge: undefined,
        error: undefined,
      });
    },
  };

  return machine;
};
