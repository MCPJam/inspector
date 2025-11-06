/**
 * OAuth 2.0 State Machine for MCP - 2025-03-26 Protocol
 *
 * This implementation follows the 2025-03-26 MCP OAuth specification:
 * - Registration priority: DCR (SHOULD) > Pre-registered
 * - Discovery: Direct OAuth 2.0 (RFC8414) from MCP server base URL with fallback endpoints
 * - PKCE: Recommended but not strictly required
 * - No Protected Resource Metadata (RFC9728) support
 * - No Client ID Metadata Documents support
 */

import { decodeJWT, formatJWTTimestamp } from "../../jwt-decoder";
import { EMPTY_OAUTH_FLOW_STATE } from "./types";
import type {
  OAuthFlowStep,
  OAuthFlowState,
  OAuthStateMachine,
  RegistrationStrategy2025_03_26,
  HttpHistoryEntry,
} from "./types";
import type { DiagramAction } from "./shared/types";
import {
  proxyFetch,
  addInfoLog,
  generateRandomString,
  generateCodeChallenge,
  loadPreregisteredCredentials,
  markLatestHttpEntryAsError,
  toLogErrorDetails,
} from "./shared/helpers";

// Re-export types for backward compatibility
export type { OAuthFlowStep, OAuthFlowState };
export { EMPTY_OAUTH_FLOW_STATE };

// Legacy type alias
export type OauthFlowStateJune2025 = OAuthFlowState;

// Legacy state export
export const EMPTY_OAUTH_FLOW_STATE_V2: OauthFlowStateJune2025 =
  EMPTY_OAUTH_FLOW_STATE;

// Configuration for creating the state machine (2025-03-26 specific)
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
  registrationStrategy?: RegistrationStrategy2025_03_26; // dcr | preregistered only
}

/**
 * Build the sequence of actions for the 2025-03-26 OAuth flow
 * This function creates the visual representation of the OAuth flow steps
 * that will be displayed in the sequence diagram.
 */
export function buildActions_2025_03_26(
  flowState: OAuthFlowState,
  registrationStrategy: "dcr" | "preregistered",
): DiagramAction[] {
  return [
    // 2025-03-26: NO Protected Resource Metadata (RFC9728) support
    // Flow starts directly with Authorization Server Metadata discovery
    {
      id: "request_authorization_server_metadata",
      label: "GET /.well-known/oauth-authorization-server from MCP base URL",
      description:
        "Direct discovery from MCP server base URL with fallback to /authorize, /token, /register",
      from: "client",
      to: "authServer",
      details: flowState.authorizationServerUrl
        ? [
            { label: "URL", value: flowState.authorizationServerUrl },
            { label: "Protocol", value: "2025-03-26" },
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
    // Client registration steps (no CIMD support in 2025-03-26)
    ...(registrationStrategy === "dcr"
      ? [
          {
            id: "request_client_registration",
            label: "POST /register (2025-03-26)",
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
            label: "Use Pre-registered Client (2025-03-26)",
            description: "Client uses pre-configured credentials (skipped DCR)",
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
      label: "Generate PKCE parameters",
      description:
        "Client generates code verifier and challenge (recommended), includes resource parameter",
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
            { label: "resource", value: flowState.serverUrl || "—" },
            { label: "Protocol", value: "2025-03-26" },
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
            { label: "resource", value: flowState.serverUrl || "" },
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
            { label: "resource", value: flowState.serverUrl || "" },
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

// Helper: Build authorization base URL from MCP server URL (2025-03-26 specific)
// Discards path component and uses origin
function buildAuthorizationBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return url.origin;
}

// Helper: Build authorization server metadata URLs to try (RFC 8414 ONLY)
// 2025-03-26 spec: Try path-aware discovery first, then root fallback
function buildAuthServerMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const urls: string[] = [];

  if (url.pathname === "/" || url.pathname === "") {
    // Root path - only RFC8414
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
    );
  } else {
    // Path-aware discovery - RFC8414 with path, then root fallback
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
    );
  }

  return urls;
}

// Factory function to create the 2025-03-26 state machine
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
    registrationStrategy = "dcr", // Default to DCR for 2025-03-26
  } = config;

  const redirectUri =
    redirectUrl || `${window.location.origin}/oauth/callback/debug`;

  const mergeHeaders = (requestHeaders: Record<string, string> = {}) => {
    return {
      ...customHeaders,
      ...requestHeaders,
    };
  };

  const getCurrentState = () => (getState ? getState() : initialState);

  const machine: OAuthStateMachine = {
    state: initialState,
    updateState,

    proceedToNextStep: async () => {
      const state = getCurrentState();

      updateState({ isInitiatingAuth: true });

      try {
        switch (state.currentStep) {
          case "idle":
            // For March 2025-03-26 protocol: Start directly with OAuth discovery
            // Per spec "Authorization Flow Steps", the flow starts with metadata discovery
            // No initial MCP request is shown in the canonical flow diagram
            updateState({
              currentStep: "discovery_start",
              serverUrl,
              httpHistory: [],
              isInitiatingAuth: false,
            });

            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_without_token":
            // Step 2: Request MCP server and expect 401 or 200
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            try {
              const response = await proxyFetch(state.serverUrl, {
                method: "POST",
                headers: mergeHeaders({
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "initialize",
                  params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: {
                      name: "MCP Inspector",
                      version: "1.0.0",
                    },
                  },
                  id: 1,
                }),
              });

              const responseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              const updatedHistory = [...(state.httpHistory || [])];
              if (updatedHistory.length > 0) {
                const lastEntry = updatedHistory[updatedHistory.length - 1];
                lastEntry.response = responseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (response.status === 401 || response.status === 200) {
                // Expected response - proceed with OAuth discovery
                const infoLogs =
                  response.status === 200
                    ? addInfoLog(
                        state,
                        "discovery_start",
                        "optional-auth",
                        "Optional Authentication",
                        {
                          message: "Server allows anonymous access",
                          note: "Proceeding with OAuth discovery for authenticated features",
                        },
                      )
                    : state.infoLogs;

                updateState({
                  currentStep: "discovery_start",
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  infoLogs,
                  isInitiatingAuth: false,
                });
              } else {
                updateState({
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                });
                throw new Error(
                  `Expected 401 or 200 but got HTTP ${response.status}: ${response.body?.error?.message || response.statusText}`,
                );
              }
            } catch (error) {
              throw new Error(
                `Failed to request MCP server: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            break;

          case "discovery_start":
            // Step 3: Start authorization server metadata discovery
            const authBaseUrl = buildAuthorizationBaseUrl(state.serverUrl!);
            const authServerUrls = buildAuthServerMetadataUrls(authBaseUrl);

            const authServerRequest = {
              method: "GET",
              url: authServerUrls[0],
              headers: mergeHeaders({}),
            };

            updateState({
              currentStep: "request_authorization_server_metadata",
              authorizationServerUrl: authBaseUrl,
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

            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_authorization_server_metadata":
            // Step 4: Fetch authorization server metadata with fallback
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const urlsToTry = buildAuthServerMetadataUrls(
              state.authorizationServerUrl,
            );
            let authServerMetadata = null;
            let lastError = null;
            let successUrl = "";
            let finalResponseData: any = null;

            for (const url of urlsToTry) {
              try {
                const requestHeaders = mergeHeaders({});

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

                const response = await proxyFetch(url, {
                  method: "GET",
                  headers: mergeHeaders({
                    "MCP-Protocol-Version": "2025-03-26",
                  }),
                });

                if (response.ok) {
                  authServerMetadata = response.body;
                  successUrl = url;
                  finalResponseData = response;
                  break;
                } else if (response.status >= 400 && response.status < 500) {
                  continue;
                } else {
                  lastError = new Error(`HTTP ${response.status} from ${url}`);
                }
              } catch (error) {
                lastError = error;
                continue;
              }
            }

            // If discovery failed, use fallback endpoints
            if (!authServerMetadata) {
              const baseUrl = state.authorizationServerUrl;
              authServerMetadata = {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/authorize`,
                token_endpoint: `${baseUrl}/token`,
                registration_endpoint: `${baseUrl}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
              };

              const fallbackInfo = addInfoLog(
                getCurrentState(),
                "received_authorization_server_metadata",
                "fallback-endpoints",
                "Using Fallback Endpoints",
                {
                  Note: "Metadata discovery failed, using default endpoints per 2025-03-26 spec",
                  "Authorization Endpoint":
                    authServerMetadata.authorization_endpoint,
                  "Token Endpoint": authServerMetadata.token_endpoint,
                  "Registration Endpoint":
                    authServerMetadata.registration_endpoint,
                },
              );

              updateState({
                currentStep: "received_authorization_server_metadata",
                authorizationServerMetadata: authServerMetadata,
                infoLogs: fallbackInfo,
                isInitiatingAuth: false,
              });
              break;
            }

            // Validate required AS metadata fields
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
              headers: finalResponseData.headers,
              body: authServerMetadata,
            };

            const updatedHistoryFinal = [...(state.httpHistory || [])];
            if (updatedHistoryFinal.length > 0) {
              const lastEntry =
                updatedHistoryFinal[updatedHistoryFinal.length - 1];
              lastEntry.response = authServerResponseData;
              lastEntry.duration =
                Date.now() - (lastEntry.timestamp || Date.now());
            }

            // PKCE validation (recommended but not required in 2025-03-26)
            const supportedMethods =
              authServerMetadata.code_challenge_methods_supported || [];

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

            if (
              !supportedMethods ||
              supportedMethods.length === 0 ||
              !supportedMethods.includes("S256")
            ) {
              console.warn(
                "Authorization server may not support PKCE S256 (REQUIRED for 2025-03-26 spec)",
              );
            }

            updateState({
              currentStep: "received_authorization_server_metadata",
              authorizationServerMetadata: authServerMetadata,
              lastResponse: authServerResponseData,
              httpHistory: updatedHistoryFinal,
              infoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_server_metadata":
            // Step 5: Client Registration
            if (!state.authorizationServerMetadata) {
              throw new Error("No authorization server metadata available");
            }

            if (registrationStrategy === "preregistered") {
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

              const preregInfo: Record<string, any> = {
                "Client ID": clientId,
                "Client Secret": clientSecret
                  ? "Configured"
                  : "Not provided (public client)",
                "Token Auth Method": clientSecret
                  ? "client_secret_post"
                  : "none",
                Note: "Using pre-registered client credentials (skipped DCR)",
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
              const scopesSupported =
                state.authorizationServerMetadata.scopes_supported;

              const clientMetadata: Record<string, any> = {
                client_name: "MCP Inspector Debug Client",
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              };

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

              setTimeout(() => machine.proceedToNextStep(), 50);
              return;
            } else {
              // No registration endpoint - use mock client ID
              updateState({
                currentStep: "generate_pkce_parameters",
                clientId: "mock-client-id-for-demo",
                tokenEndpointAuthMethod: "none",
                isInitiatingAuth: false,
              });
            }
            break;

          case "request_client_registration":
            // Step 6: Dynamic Client Registration
            if (!state.authorizationServerMetadata?.registration_endpoint) {
              throw new Error("No registration endpoint available");
            }

            if (!state.lastRequest?.body) {
              throw new Error("No client metadata in request");
            }

            try {
              const response = await proxyFetch(
                state.authorizationServerMetadata.registration_endpoint,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(state.lastRequest.body),
                },
              );

              const registrationResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              const updatedHistoryReg = [...(state.httpHistory || [])];
              if (updatedHistoryReg.length > 0) {
                const lastEntry =
                  updatedHistoryReg[updatedHistoryReg.length - 1];
                lastEntry.response = registrationResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                updateState({
                  lastResponse: registrationResponseData,
                  httpHistory: updatedHistoryReg,
                  error: `Dynamic Client Registration failed (${response.status}). Using fallback client ID.`,
                });

                const fallbackClientId = "preregistered-client-id";

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: fallbackClientId,
                  clientSecret: undefined,
                  tokenEndpointAuthMethod: "none",
                  isInitiatingAuth: false,
                });
              } else {
                const clientInfo = response.body;

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

              const fallbackClientId = "preregistered-client-id";

              updateState({
                currentStep: "received_client_credentials",
                clientId: fallbackClientId,
                clientSecret: undefined,
                tokenEndpointAuthMethod: "none",
                isInitiatingAuth: false,
              });
            }
            break;

          case "received_client_credentials":
            // Step 7: Generate PKCE parameters (REQUIRED for 2025-03-26)
            const codeVerifier = generateRandomString(43);
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            const pkceInfoLogs = addInfoLog(
              getCurrentState(),
              "generate_pkce_parameters",
              "pkce-generation",
              "Generate PKCE Parameters (REQUIRED)",
              {
                code_challenge: codeChallenge,
                method: "S256",
                resource: state.serverUrl || "Unknown",
                note: "PKCE is REQUIRED for all clients in 2025-03-26 spec",
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
            if (state.serverUrl) {
              authUrl.searchParams.set("resource", state.serverUrl);
            }

            // Add scopes
            if (customScopes) {
              authUrl.searchParams.set("scope", customScopes);
            } else {
              const scopesSupported =
                state.authorizationServerMetadata.scopes_supported;

              const scopes = new Set<string>();

              if (scopesSupported && scopesSupported.length > 0) {
                scopesSupported.forEach((scope) => scopes.add(scope));
              }

              if (scopesSupported?.includes("offline_access")) {
                scopes.add("offline_access");
              }

              if (scopes.size > 0) {
                authUrl.searchParams.set("scope", Array.from(scopes).join(" "));
              }
            }

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
              authorizationCode: undefined,
              accessToken: undefined,
              refreshToken: undefined,
              tokenType: undefined,
              expiresIn: undefined,
              infoLogs: authUrlInfoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "authorization_request":
            // Step 9: Wait for authorization code
            updateState({
              currentStep: "received_authorization_code",
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_code":
            // Step 10: Prepare token exchange
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

            if (state.serverUrl) {
              tokenRequestBodyObj.resource = state.serverUrl;
            }

            const tokenRequest = {
              method: "POST",
              url: state.authorizationServerMetadata.token_endpoint,
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: tokenRequestBodyObj,
            };

            updateState({
              currentStep: "token_request",
              lastRequest: tokenRequest,
              lastResponse: undefined,
              accessToken: undefined,
              refreshToken: undefined,
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
                "PKCE code_verifier is missing - REQUIRED by 2025-03-26 spec for token exchange",
              );
            }

            try {
              const tokenRequestBody = new URLSearchParams({
                grant_type: "authorization_code",
                code: state.authorizationCode,
                redirect_uri: redirectUri,
                client_id: state.clientId || "",
                code_verifier: state.codeVerifier || "",
              });

              if (state.clientSecret) {
                tokenRequestBody.set("client_secret", state.clientSecret);
              }

              if (state.serverUrl) {
                tokenRequestBody.set("resource", state.serverUrl);
              }

              const response = await proxyFetch(
                state.authorizationServerMetadata.token_endpoint,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: tokenRequestBody.toString(),
                },
              );

              const tokenResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              const updatedHistoryToken = [...(state.httpHistory || [])];
              if (updatedHistoryToken.length > 0) {
                const lastEntry =
                  updatedHistoryToken[updatedHistoryToken.length - 1];
                lastEntry.response = tokenResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                updateState({
                  lastResponse: tokenResponseData,
                  httpHistory: updatedHistoryToken,
                  authorizationCode: undefined,
                  error: `Token request failed: ${response.body?.error || response.statusText} - ${response.body?.error_description || "Unknown error"}`,
                  isInitiatingAuth: false,
                });
                return;
              }

              const tokens = response.body;

              const existingLogs = (getCurrentState().infoLogs || []).filter(
                (log) =>
                  log.id !== "auth-code" &&
                  log.id !== "oauth-tokens" &&
                  log.id !== "token",
              );

              let tokenInfoLogs = existingLogs;

              if (state.authorizationCode) {
                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "auth-code",
                    level: "info",
                    step: "received_authorization_code",
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
                    step: "received_access_token",
                    label: "OAuth Tokens",
                    data: tokenData,
                    timestamp: Date.now(),
                  },
                ];
              }

              if (tokens.access_token) {
                const decoded = decodeJWT(tokens.access_token);
                if (decoded) {
                  const formatted = { ...decoded };
                  if (formatted.exp) {
                    formatted.exp = `${formatted.exp} (${formatJWTTimestamp(formatted.exp)})`;
                  }
                  if (formatted.iat) {
                    formatted.iat = `${formatted.iat} (${formatJWTTimestamp(formatted.iat)})`;
                  }
                  if (formatted.nbf) {
                    formatted.nbf = `${formatted.nbf} (${formatJWTTimestamp(formatted.nbf)})`;
                  }

                  const audienceNote: Record<string, any> = {
                    ...formatted,
                  };

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
                      step: "received_access_token",
                      level: "info",
                      label: "Access Token (Decoded JWT)",
                      data: audienceNote,
                      timestamp: Date.now(),
                    },
                  ];
                }
              }

              if (tokens.id_token) {
                const decodedIdToken = decodeJWT(tokens.id_token);
                if (decodedIdToken) {
                  const formattedIdToken = { ...decodedIdToken };
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

                  formattedIdToken._note =
                    "OIDC ID Token - Used for user identity verification";

                  tokenInfoLogs = [
                    ...tokenInfoLogs,
                    {
                      id: "id-token",
                      step: "received_access_token",
                      level: "info",
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
            // Step 12: Make authenticated MCP request
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            const authenticatedRequest = {
              method: "POST",
              url: state.serverUrl,
              headers: {
                Authorization: `Bearer ${state.accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
              },
              body: {
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: {
                    name: "MCP Inspector",
                    version: "1.0.0",
                  },
                },
                id: 2,
              },
            };

            const authenticatedRequestInfoLogs = addInfoLog(
              getCurrentState(),
              "authenticated_mcp_request",
              "authenticated-init",
              "Authenticated MCP Initialize Request",
              {
                Request: "MCP initialize with OAuth bearer token",
                "Protocol Version": "2025-03-26",
                Client: "MCP Inspector v1.0.0",
                Endpoint: state.serverUrl,
              },
            );

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

            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "authenticated_mcp_request":
            // Step 13: Make actual authenticated request
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            try {
              const response = await proxyFetch(state.serverUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${state.accessToken}`,
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "initialize",
                  params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: {
                      name: "MCP Inspector",
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

              const updatedHistoryMcp = [...(state.httpHistory || [])];
              if (updatedHistoryMcp.length > 0) {
                const lastEntry =
                  updatedHistoryMcp[updatedHistoryMcp.length - 1];
                lastEntry.response = mcpResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                // Backwards compatibility: Check if this is using old HTTP+SSE transport
                // Per spec: "If it fails with an HTTP 4xx status code (e.g., 405 Method Not Allowed or 404 Not Found):
                // Issue a GET request to the server URL, expecting that this will open an SSE stream and return an endpoint event"
                if (response.status >= 400 && response.status < 500) {
                  try {
                    // Add GET request to history
                    const getRequest = {
                      method: "GET",
                      url: state.serverUrl,
                      headers: {
                        Authorization: `Bearer ${state.accessToken}`,
                        Accept: "text/event-stream",
                      },
                    };

                    const getHistoryEntry: HttpHistoryEntry = {
                      step: "complete",
                      timestamp: Date.now(),
                      request: getRequest,
                    };

                    updatedHistoryMcp.push(getHistoryEntry);

                    // Add info log for backwards compatibility attempt
                    let fallbackInfoLogs = addInfoLog(
                      getCurrentState(),
                      "authenticated_mcp_request",
                      "http-sse-fallback-attempt",
                      "Backwards Compatibility Check",
                      {
                        Reason: `POST failed with ${response.status}, checking for old HTTP+SSE transport`,
                        "GET Request": state.serverUrl,
                        Note: "Attempting to detect SSE stream with 'endpoint' event",
                      },
                    );

                    updateState({
                      infoLogs: fallbackInfoLogs,
                      httpHistory: updatedHistoryMcp,
                    });

                    const getResponse = await proxyFetch(state.serverUrl, {
                      method: "GET",
                      headers: {
                        Authorization: `Bearer ${state.accessToken}`,
                        Accept: "text/event-stream",
                      },
                    });

                    // Update history with response
                    getHistoryEntry.response = {
                      status: getResponse.status,
                      statusText: getResponse.statusText,
                      headers: getResponse.headers,
                      body: getResponse.body,
                    };
                    getHistoryEntry.duration =
                      Date.now() - getHistoryEntry.timestamp;

                    // Check if we got an SSE stream with an endpoint event
                    const sseBody = getResponse.body;

                    // Handle structured SSE response from debug proxy
                    if (
                      sseBody &&
                      typeof sseBody === "object" &&
                      sseBody.isOldTransport &&
                      sseBody.endpoint
                    ) {
                      const endpoint = sseBody.endpoint;
                      const fullEndpoint = new URL(
                        endpoint,
                        state.serverUrl,
                      ).toString();

                      const httpSseInfoLogs = addInfoLog(
                        getCurrentState(),
                        "authenticated_mcp_request",
                        "http-sse-detected",
                        "HTTP+SSE Transport Detected (2024-11-05)",
                        {
                          Transport: "HTTP+SSE (2024-11-05 - Deprecated)",
                          "SSE Stream URL": state.serverUrl,
                          "POST Endpoint": fullEndpoint,
                          "First Event": sseBody.events?.[0],
                          Note: "Server uses the old HTTP+SSE transport. All subsequent MCP requests should be POSTed to the endpoint above.",
                        },
                      );

                      updateState({
                        currentStep: "complete",
                        lastResponse: {
                          status: getResponse.status,
                          statusText: "OK - HTTP+SSE Transport",
                          headers: getResponse.headers,
                          body: {
                            transport: "HTTP+SSE (2024-11-05)",
                            sseStreamUrl: state.serverUrl,
                            postEndpoint: fullEndpoint,
                            events: sseBody.events,
                          },
                        },
                        httpHistory: updatedHistoryMcp,
                        infoLogs: httpSseInfoLogs,
                        error: undefined,
                        isInitiatingAuth: false,
                      });
                      return;
                    }
                  } catch (getError) {
                    // If GET also fails, fall through to original error
                    console.error("GET fallback failed:", getError);
                  }
                }

                updateState({
                  lastResponse: mcpResponseData,
                  httpHistory: updatedHistoryMcp,
                  error: `Authenticated request failed: ${response.status} ${response.statusText}`,
                  isInitiatingAuth: false,
                });
                return;
              }

              let mcpInfoLogs = getCurrentState().infoLogs || [];

              const contentType = response.headers["content-type"] || "";
              const isSSE = contentType.includes("text/event-stream");

              let mcpResponse = null;
              // Handle structured SSE response from debug proxy
              if (isSSE && response.body?.transport === "sse") {
                mcpResponse = response.body.mcpResponse;
              } else {
                mcpResponse = response.body;
              }

              if (isSSE && mcpResponse?.result?.protocolVersion) {
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "Server-Sent Events (streaming)",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

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
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "JSON",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

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
              const errorDetails = toLogErrorDetails(error);
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: mergeHeaders({}),
                body: {
                  error: errorDetails.message,
                  details: errorDetails.details,
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry = {
                  ...updatedHistoryError[updatedHistoryError.length - 1],
                  response: errorResponse,
                  duration:
                    Date.now() -
                    (updatedHistoryError[updatedHistoryError.length - 1]
                      ?.timestamp || Date.now()),
                  error: errorDetails,
                };
                updatedHistoryError[updatedHistoryError.length - 1] = lastEntry;
              }

              const currentState = getCurrentState();
              const infoLogs = addInfoLog(
                currentState,
                "authenticated_mcp_request",
                `error-authenticated_mcp_request-${Date.now()}`,
                "Authenticated MCP request failed",
                {
                  request: currentState.lastRequest,
                  error: errorDetails,
                },
                { level: "error", error: errorDetails },
              );

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                infoLogs,
                error: `Authenticated MCP request failed: ${errorDetails.message}`,
                isInitiatingAuth: false,
              });
            }
            break;

          case "complete":
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

    startGuidedFlow: async () => {
      updateState({
        currentStep: "idle",
        isInitiatingAuth: false,
      });
    },

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
