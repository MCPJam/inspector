import { decodeJWT, formatJWTTimestamp } from "./jwt-decoder";

// OAuth flow steps based on MCP specification
export type OAuthFlowStep =
  | "idle"
  | "request_without_token"
  | "received_401_unauthorized"
  | "request_resource_metadata"
  | "received_resource_metadata"
  | "request_authorization_server_metadata"
  | "received_authorization_server_metadata"
  | "request_client_registration"
  | "received_client_credentials"
  | "generate_pkce_parameters"
  | "authorization_request"
  | "received_authorization_code"
  | "token_request"
  | "received_access_token"
  | "authenticated_mcp_request"
  | "complete";

// State interface for OAuth flow
export interface OauthFlowStateJune2025 {
  isInitiatingAuth: boolean;
  currentStep: OAuthFlowStep;
  // Data collected during the flow
  serverUrl?: string;
  wwwAuthenticateHeader?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: {
    resource: string;
    authorization_servers?: string[];
    bearer_methods_supported?: string[];
    resource_signing_alg_values_supported?: string[];
    scopes_supported?: string[];
  };
  authorizationServerUrl?: string;
  authorizationServerMetadata?: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    response_types_supported: string[];
    grant_types_supported?: string[];
    code_challenge_methods_supported?: string[];
  };
  // Client Registration
  clientId?: string;
  clientSecret?: string;
  // PKCE Parameters
  codeVerifier?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  // Authorization
  authorizationUrl?: string;
  authorizationCode?: string;
  state?: string;
  // Tokens
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  // Raw request/response data for debugging
  lastRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: any;
  };
  lastResponse?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any; // JSON response body
  };
  // History of all request/response pairs
  httpHistory?: Array<{
    step: OAuthFlowStep;
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: any;
    };
    response?: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: any;
    };
  }>;
  // Info logs for OAuth flow debugging
  infoLogs?: Array<{
    id: string;
    label: string;
    data: any;
    timestamp: number;
  }>;
  error?: string;
  // Add more state properties here as needed
}

// Initial empty state
export const EMPTY_OAUTH_FLOW_STATE_V2: OauthFlowStateJune2025 = {
  isInitiatingAuth: false,
  currentStep: "idle",
  httpHistory: [],
  infoLogs: [],
};

// State machine interface
export interface DebugOAuthStateMachine {
  state: OauthFlowStateJune2025;
  updateState: (updates: Partial<OauthFlowStateJune2025>) => void;
  proceedToNextStep: () => Promise<void>;
  startGuidedFlow: () => Promise<void>;
  resetFlow: () => void;
}

// Configuration for creating the state machine
export interface DebugOAuthStateMachineConfig {
  state: OauthFlowStateJune2025;
  getState?: () => OauthFlowStateJune2025; // Optional getter for always-fresh state
  updateState: (updates: Partial<OauthFlowStateJune2025>) => void;
  serverUrl: string;
  serverName: string;
  redirectUrl?: string; // Redirect URL for OAuth callback
  fetchFn?: typeof fetch; // Optional fetch function for testing
}

// Helper: Build well-known resource metadata URL from server URL
// This follows RFC 9728 OAuth 2.0 Protected Resource Metadata
function buildResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  // Try path-aware discovery first (if server has a path)
  if (url.pathname !== "/" && url.pathname !== "") {
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return new URL(
      `/.well-known/oauth-protected-resource${pathname}`,
      url.origin,
    ).toString();
  }
  // Otherwise use root discovery
  return new URL(
    "/.well-known/oauth-protected-resource",
    url.origin,
  ).toString();
}

// Helper: Build authorization server metadata URLs to try (RFC 8414 + OIDC Discovery)
function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (url.pathname === "/" || url.pathname === "") {
    // Root path
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
    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
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

// Helper function to make requests via backend proxy (bypasses CORS)
async function proxyFetch(
  url: string,
  options: RequestInit = {},
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
}> {
  // Determine if body is JSON or form-urlencoded
  let bodyToSend: any = undefined;
  if (options.body) {
    const contentType = (options.headers as Record<string, string>)?.[
      Object.keys((options.headers as Record<string, string>) || {}).find(
        (k) => k.toLowerCase() === "content-type",
      ) || ""
    ];

    if (contentType?.includes("application/x-www-form-urlencoded")) {
      // For form-urlencoded, convert to object
      const params = new URLSearchParams(options.body as string);
      bodyToSend = Object.fromEntries(params.entries());
    } else if (typeof options.body === "string") {
      // Try to parse as JSON
      try {
        bodyToSend = JSON.parse(options.body);
      } catch {
        bodyToSend = options.body;
      }
    } else {
      bodyToSend = options.body;
    }
  }

  const response = await fetch("/api/mcp/oauth/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      method: options.method || "GET",
      body: bodyToSend,
      headers: options.headers,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Backend proxy error: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return {
    ...data,
    ok: data.status >= 200 && data.status < 300,
  };
}

// Factory function to create the state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig,
): DebugOAuthStateMachine => {
  const {
    state: initialState,
    getState,
    updateState,
    serverUrl,
    serverName,
    redirectUrl,
    fetchFn = fetch,
  } = config;

  // Use provided redirectUrl or default to the origin + /oauth/callback/debug
  const redirectUri =
    redirectUrl || `${window.location.origin}/oauth/callback/debug`;

  // Helper to get current state (use getState if provided, otherwise use initial state)
  const getCurrentState = () => (getState ? getState() : initialState);

  // Create machine object that can reference itself
  const machine: DebugOAuthStateMachine = {
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
            const initialRequest = {
              method: "POST",
              url: serverUrl,
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
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

              if (response.status === 401) {
                // Expected 401 response with WWW-Authenticate header
                const wwwAuthenticateHeader =
                  response.headers["www-authenticate"];

                const responseData = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.body,
                };

                // Update the last history entry with the response
                const updatedHistory = [...(state.httpHistory || [])];
                if (updatedHistory.length > 0) {
                  updatedHistory[updatedHistory.length - 1].response =
                    responseData;
                }

                // Add info log for WWW-Authenticate header
                const infoLogs = wwwAuthenticateHeader
                  ? addInfoLog(
                      state,
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
              } else {
                throw new Error(
                  `Expected 401 Unauthorized but got HTTP ${response.status}`,
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
              headers: {
                Accept: "application/json",
              },
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
                  request: resourceMetadataRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            setTimeout(() => machine.proceedToNextStep(), 50);
            return;

          case "request_resource_metadata":
            // Step 2: Fetch and parse resource metadata via backend proxy
            if (!state.resourceMetadataUrl) {
              throw new Error("No resource metadata URL available");
            }

            try {
              // Use backend proxy to bypass CORS
              const response = await proxyFetch(state.resourceMetadataUrl, {
                method: "GET",
              });

              if (!response.ok) {
                // Capture failed response
                const failedResponseData = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.body,
                };

                // Update the last history entry with the failed response
                const updatedHistoryFailed = [...(state.httpHistory || [])];
                if (updatedHistoryFailed.length > 0) {
                  updatedHistoryFailed[
                    updatedHistoryFailed.length - 1
                  ].response = failedResponseData;
                }

                updateState({
                  lastResponse: failedResponseData,
                  httpHistory: updatedHistoryFailed,
                });

                if (response.status === 404) {
                  throw new Error(
                    "Server does not implement OAuth 2.0 Protected Resource Metadata (404)",
                  );
                }
                throw new Error(
                  `Failed to fetch resource metadata: HTTP ${response.status}`,
                );
              }

              const resourceMetadata = response.body;

              // Validate required fields per RFC 9728
              if (!resourceMetadata.resource) {
                throw new Error(
                  "Resource metadata missing required 'resource' field",
                );
              }
              if (
                !resourceMetadata.authorization_servers ||
                resourceMetadata.authorization_servers.length === 0
              ) {
                throw new Error(
                  "Resource metadata missing 'authorization_servers'",
                );
              }

              // Extract authorization server URL (use first one if multiple, fallback to server URL)
              const authorizationServerUrl =
                resourceMetadata.authorization_servers?.[0] || serverUrl;

              const successResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: resourceMetadata,
              };

              // Update the last history entry with the response
              const updatedHistory = [...(state.httpHistory || [])];
              if (updatedHistory.length > 0) {
                updatedHistory[updatedHistory.length - 1].response =
                  successResponseData;
              }

              // Add info log for Authorization Servers
              const infoLogs = addInfoLog(
                state,
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
                authorizationServerUrl,
                lastResponse: successResponseData,
                httpHistory: updatedHistory,
                infoLogs,
                isInitiatingAuth: false,
              });
            } catch (error) {
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
              headers: {
                Accept: "application/json",
              },
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
                const requestHeaders = {
                  Accept: "application/json",
                };

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
              updatedHistoryFinal[updatedHistoryFinal.length - 1].response =
                authServerResponseData;
            }

            // Validate PKCE support
            const supportedMethods =
              authServerMetadata.code_challenge_methods_supported || [];

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
            // Step 5: Dynamic Client Registration (if registration_endpoint exists)
            if (!state.authorizationServerMetadata) {
              throw new Error("No authorization server metadata available");
            }

            if (state.authorizationServerMetadata.registration_endpoint) {
              // Prepare client metadata with scopes if available
              const scopesSupported =
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported;

              const clientMetadata: Record<string, any> = {
                client_name: "MCP Inspector Debug Client",
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
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
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
                    request: registrationRequest,
                  },
                ],
                isInitiatingAuth: false,
              });

              // Automatically proceed to make the actual request
              setTimeout(() => machine.proceedToNextStep(), 50);
              return;
            } else {
              // Skip to PKCE generation with a mock client ID
              updateState({
                currentStep: "generate_pkce_parameters",
                clientId: "mock-client-id-for-demo",
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
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
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

              // Update the last history entry with the response
              const updatedHistoryReg = [...(state.httpHistory || [])];
              if (updatedHistoryReg.length > 0) {
                updatedHistoryReg[updatedHistoryReg.length - 1].response =
                  registrationResponseData;
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
                  isInitiatingAuth: false,
                });
              } else {
                // Registration successful
                const clientInfo = response.body;

                // Add info log for DCR
                const dcrInfo: Record<string, any> = {
                  "Client ID": clientInfo.client_id,
                  "Client Name": clientInfo.client_name,
                  "Token Auth Method": clientInfo.token_endpoint_auth_method,
                  "Redirect URIs": clientInfo.redirect_uris,
                  "Grant Types": clientInfo.grant_types,
                  "Response Types": clientInfo.response_types,
                };

                if (clientInfo.client_secret) {
                  dcrInfo["Client Secret"] =
                    clientInfo.client_secret.substring(0, 20) + "...";
                }

                const infoLogs = addInfoLog(
                  getCurrentState(),
                  "dcr",
                  "Dynamic Client Registration",
                  dcrInfo,
                );

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: clientInfo.client_id,
                  clientSecret: clientInfo.client_secret,
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
                headers: {},
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                updatedHistoryError[updatedHistoryError.length - 1].response =
                  errorResponse;
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
                isInitiatingAuth: false,
              });
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
              "pkce-generation",
              "Generate PKCE Parameters",
              {
                code_challenge: codeChallenge,
                method: "S256",
                resource: state.serverUrl || "Unknown",
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

            // Add info log for Authorization URL
            const authUrlInfoLogs = addInfoLog(
              getCurrentState(),
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
                Accept: "application/json",
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

              // Add resource parameter if available
              if (state.serverUrl) {
                tokenRequestBody.set("resource", state.serverUrl);
              }

              // Make the token request via backend proxy
              const response = await proxyFetch(
                state.authorizationServerMetadata.token_endpoint,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
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

              // Update the last history entry with the response
              const updatedHistoryToken = [...(state.httpHistory || [])];
              if (updatedHistoryToken.length > 0) {
                updatedHistoryToken[updatedHistoryToken.length - 1].response =
                  tokenResponseData;
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

              let tokenInfoLogs = getCurrentState().infoLogs || [];

              // Add Authorization Code log if not already added
              if (
                state.authorizationCode &&
                !tokenInfoLogs.find((log) => log.id === "auth-code")
              ) {
                tokenInfoLogs = addInfoLog(
                  { ...getCurrentState(), infoLogs: tokenInfoLogs },
                  "auth-code",
                  "Authorization Code",
                  {
                    code: state.authorizationCode,
                  },
                );
              }

              // Add refresh token log if present and not already added
              if (
                tokens.refresh_token &&
                !tokenInfoLogs.find((log) => log.id === "refresh-token")
              ) {
                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "refresh-token",
                    label: "Refresh Token",
                    data: {
                      token: tokens.refresh_token.substring(0, 50) + "...",
                    },
                    timestamp: Date.now(),
                  },
                ];
              }

              // Decode and add access token log if not already added
              if (
                tokens.access_token &&
                !tokenInfoLogs.find((log) => log.id === "token")
              ) {
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

                  tokenInfoLogs = addInfoLog(
                    { ...getCurrentState(), infoLogs: tokenInfoLogs },
                    "token",
                    "Access Token (Decoded JWT)",
                    formatted,
                  );
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
                headers: {},
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                updatedHistoryError[updatedHistoryError.length - 1].response =
                  errorResponse;
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

            // Update state with the request
            updateState({
              currentStep: "authenticated_mcp_request",
              lastRequest: authenticatedRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "authenticated_mcp_request",
                  request: authenticatedRequest,
                },
              ],
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

              // Update the last history entry with the response
              const updatedHistoryMcp = [...(state.httpHistory || [])];
              if (updatedHistoryMcp.length > 0) {
                updatedHistoryMcp[updatedHistoryMcp.length - 1].response =
                  mcpResponseData;
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

              updateState({
                currentStep: "complete",
                lastResponse: mcpResponseData,
                httpHistory: updatedHistoryMcp,
                error: undefined,
                isInitiatingAuth: false,
              });
            } catch (error) {
              // Capture the error
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: {},
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                updatedHistoryError[updatedHistoryError.length - 1].response =
                  errorResponse;
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
        updateState({
          error: error instanceof Error ? error.message : String(error),
          isInitiatingAuth: false,
        });
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

// Helper function to add an info log to the state
function addInfoLog(
  state: OauthFlowStateJune2025,
  id: string,
  label: string,
  data: any,
): Array<{ id: string; label: string; data: any; timestamp: number }> {
  return [
    ...(state.infoLogs || []),
    {
      id,
      label,
      data,
      timestamp: Date.now(),
    },
  ];
}

// Helper function to generate random string for PKCE
function generateRandomString(length: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(
    randomValues,
    (byte) => charset[byte % charset.length],
  ).join("");
}

// Helper function to generate code challenge from verifier
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
