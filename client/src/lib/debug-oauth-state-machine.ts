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
  | "complete"
  ;

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
  error?: string;
  // Add more state properties here as needed
}

// Initial empty state
export const EMPTY_OAUTH_FLOW_STATE_V2: OauthFlowStateJune2025 = {
  isInitiatingAuth: false,
  currentStep: "idle",
  httpHistory: [],
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
  fetchFn?: typeof fetch; // Optional fetch function for testing
}

// Helper: Build well-known resource metadata URL from server URL
// This follows RFC 9728 OAuth 2.0 Protected Resource Metadata
function buildResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  // Try path-aware discovery first (if server has a path)
  if (url.pathname !== '/' && url.pathname !== '') {
    const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    return new URL(`/.well-known/oauth-protected-resource${pathname}`, url.origin).toString();
  }
  // Otherwise use root discovery
  return new URL("/.well-known/oauth-protected-resource", url.origin).toString();
}

// Helper: Build authorization server metadata URLs to try (RFC 8414 + OIDC Discovery)
function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (url.pathname === '/' || url.pathname === '') {
    // Root path
    urls.push(new URL('/.well-known/oauth-authorization-server', url.origin).toString());
    urls.push(new URL('/.well-known/openid-configuration', url.origin).toString());
  } else {
    // Path-aware discovery
    const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    urls.push(new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin).toString());
    urls.push(new URL('/.well-known/oauth-authorization-server', url.origin).toString());
    urls.push(new URL(`/.well-known/openid-configuration${pathname}`, url.origin).toString());
    urls.push(new URL(`${pathname}/.well-known/openid-configuration`, url.origin).toString());
  }

  return urls;
}

// Helper function to make requests via backend proxy (bypasses CORS)
async function proxyFetch(url: string, options: RequestInit = {}): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
}> {
  const response = await fetch("/api/mcp/oauth/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body as string) : undefined,
      headers: options.headers,
    }),
  });

  if (!response.ok) {
    throw new Error(`Backend proxy error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    ...data,
    ok: data.status >= 200 && data.status < 300,
  };
}

// Factory function to create the state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig
): DebugOAuthStateMachine => {
  const { state: initialState, getState, updateState, serverUrl, serverName, fetchFn = fetch } = config;

  // Helper to get current state (use getState if provided, otherwise use initial state)
  const getCurrentState = () => getState ? getState() : initialState;

  // Create machine object that can reference itself
  const machine: DebugOAuthStateMachine = {
    state: initialState,
    updateState,

    // Proceed to next step in the flow (matches SDK's actual approach)
    proceedToNextStep: async () => {
      const state = getCurrentState();
      console.log("[Debug OAuth] Proceeding to next step from:", state.currentStep);

      updateState({ isInitiatingAuth: true });

      try {
        switch (state.currentStep) {
          case "idle":
            // Step 1: Make initial MCP request without token
            console.log("[Debug OAuth] Making initial request to MCP server without token");

            const initialRequest = {
              method: "POST",
              url: serverUrl,
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
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

            console.log("[Debug OAuth] Requesting MCP server at:", state.serverUrl);

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
                const wwwAuthenticateHeader = response.headers["www-authenticate"];
                console.log("[Debug OAuth] Received 401 Unauthorized");
                console.log("[Debug OAuth] WWW-Authenticate header:", wwwAuthenticateHeader);

                const responseData = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.body,
                };

                // Update the last history entry with the response
                const updatedHistory = [...(state.httpHistory || [])];
                if (updatedHistory.length > 0) {
                  updatedHistory[updatedHistory.length - 1].response = responseData;
                }

                updateState({
                  currentStep: "received_401_unauthorized",
                  wwwAuthenticateHeader: wwwAuthenticateHeader || undefined,
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  isInitiatingAuth: false,
                });
              } else {
                throw new Error(`Expected 401 Unauthorized but got HTTP ${response.status}`);
              }
            } catch (error) {
              throw new Error(`Failed to request MCP server: ${error instanceof Error ? error.message : String(error)}`);
            }
            break;

          case "received_401_unauthorized":
            // Step 3: Extract resource metadata URL and prepare request
            console.log("[Debug OAuth] Extracting resource metadata URL from WWW-Authenticate header");

            let extractedResourceMetadataUrl: string | undefined;

            if (state.wwwAuthenticateHeader) {
              // Parse WWW-Authenticate header to extract resource_metadata URL
              // Format: Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"
              const resourceMetadataMatch = state.wwwAuthenticateHeader.match(/resource_metadata="([^"]+)"/);
              if (resourceMetadataMatch) {
                extractedResourceMetadataUrl = resourceMetadataMatch[1];
                console.log("[Debug OAuth] Extracted resource metadata URL:", extractedResourceMetadataUrl);
              }
            }

            // Fallback to building the URL if not found in header
            if (!extractedResourceMetadataUrl && state.serverUrl) {
              extractedResourceMetadataUrl = buildResourceMetadataUrl(state.serverUrl);
              console.log("[Debug OAuth] Using fallback resource metadata URL:", extractedResourceMetadataUrl);
            }

            if (!extractedResourceMetadataUrl) {
              throw new Error("Could not determine resource metadata URL");
            }

            console.log("[Debug OAuth] Proceeding to request resource metadata from:", extractedResourceMetadataUrl);

            const resourceMetadataRequest = {
              method: "GET",
              url: extractedResourceMetadataUrl,
              headers: {
                "Accept": "application/json",
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

            console.log("[Debug OAuth] Fetching resource metadata from:", state.resourceMetadataUrl);

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
                  updatedHistoryFailed[updatedHistoryFailed.length - 1].response = failedResponseData;
                }

                updateState({
                  lastResponse: failedResponseData,
                  httpHistory: updatedHistoryFailed,
                });

                if (response.status === 404) {
                  throw new Error("Server does not implement OAuth 2.0 Protected Resource Metadata (404)");
                }
                throw new Error(`Failed to fetch resource metadata: HTTP ${response.status}`);
              }

              const resourceMetadata = response.body;
              console.log("[Debug OAuth] Received resource metadata:", resourceMetadata);

              // Extract authorization server URL (use first one if multiple, fallback to server URL)
              const authorizationServerUrl = resourceMetadata.authorization_servers?.[0] || serverUrl;
              console.log("[Debug OAuth] Authorization server URL:", authorizationServerUrl);

              const successResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: resourceMetadata,
              };

              // Update the last history entry with the response
              const updatedHistory = [...(state.httpHistory || [])];
              if (updatedHistory.length > 0) {
                updatedHistory[updatedHistory.length - 1].response = successResponseData;
              }

              updateState({
                currentStep: "received_resource_metadata",
                resourceMetadata,
                authorizationServerUrl,
                lastResponse: successResponseData,
                httpHistory: updatedHistory,
                isInitiatingAuth: false,
              });
            } catch (error) {
              throw new Error(`Failed to request resource metadata: ${error instanceof Error ? error.message : String(error)}`);
            }
            break;

          case "received_resource_metadata":
            // Step 3: Request Authorization Server Metadata
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const authServerUrls = buildAuthServerMetadataUrls(state.authorizationServerUrl);
            console.log("[Debug OAuth] Trying authorization server metadata URLs:", authServerUrls);

            const authServerRequest = {
              method: "GET",
              url: authServerUrls[0], // Show the first URL we'll try
              headers: {
                "Accept": "application/json",
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

            const urlsToTry = buildAuthServerMetadataUrls(state.authorizationServerUrl);
            let authServerMetadata = null;
            let lastError = null;
            let successUrl = "";
            let finalRequestHeaders = {};
            let finalResponseHeaders: Record<string, string> = {};
            let finalResponseData: any = null;

            for (const url of urlsToTry) {
              try {
                console.log("[Debug OAuth] Trying:", url);
                const requestHeaders = {
                  "Accept": "application/json",
                };

                // Update request URL as we try different endpoints
                const updatedHistoryForRetry = [...(state.httpHistory || [])];
                if (updatedHistoryForRetry.length > 0) {
                  updatedHistoryForRetry[updatedHistoryForRetry.length - 1].request = {
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
                  console.log("[Debug OAuth] Found authorization server metadata at:", url);
                  console.log("[Debug OAuth] Metadata:", authServerMetadata);
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
                console.warn("[Debug OAuth] Failed to fetch from:", url, error);
                lastError = error;
                continue;
              }
            }

            if (!authServerMetadata || !finalResponseData) {
              throw new Error(`Could not discover authorization server metadata. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
              updatedHistoryFinal[updatedHistoryFinal.length - 1].response = authServerResponseData;
            }

            updateState({
              currentStep: "received_authorization_server_metadata",
              authorizationServerMetadata: authServerMetadata,
              lastResponse: authServerResponseData,
              httpHistory: updatedHistoryFinal,
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_server_metadata":
            // Step 5: Dynamic Client Registration (if registration_endpoint exists)
            if (!state.authorizationServerMetadata) {
              throw new Error("No authorization server metadata available");
            }

            if (state.authorizationServerMetadata.registration_endpoint) {
              console.log("[Debug OAuth] Registration endpoint available, proceeding to client registration");

              // Prepare client metadata with scopes if available
              const scopesSupported =
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported;

              const clientMetadata: Record<string, any> = {
                client_name: "MCP Inspector Debug Client",
                redirect_uris: ["http://localhost:3000/oauth/callback"],
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
                  "Accept": "application/json",
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
              console.log("[Debug OAuth] No registration endpoint, skipping to PKCE generation");
              console.log("[Debug OAuth] Note: In production, you would need to manually register and provide a client_id");

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

            console.log("[Debug OAuth] Registering client with authorization server");
            console.log("[Debug OAuth] Registration endpoint:", state.authorizationServerMetadata.registration_endpoint);

            try {
              // Make actual POST request to registration endpoint via backend proxy
              const response = await proxyFetch(
                state.authorizationServerMetadata.registration_endpoint,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                  },
                  body: JSON.stringify(state.lastRequest.body),
                }
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
                updatedHistoryReg[updatedHistoryReg.length - 1].response = registrationResponseData;
              }

              if (!response.ok) {
                // Registration failed - could be server doesn't support DCR or request was invalid
                console.warn("[Debug OAuth] Dynamic Client Registration failed:", response.status, response.body);

                // Update state with error but continue with fallback
                updateState({
                  lastResponse: registrationResponseData,
                  httpHistory: updatedHistoryReg,
                  error: `Dynamic Client Registration failed (${response.status}). Using fallback client ID.`,
                });

                // Fall back to mock client ID (simulating preregistered client)
                const fallbackClientId = "preregistered-client-id";
                console.log("[Debug OAuth] Using fallback client ID:", fallbackClientId);

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: fallbackClientId,
                  clientSecret: undefined,
                  isInitiatingAuth: false,
                });
              } else {
                // Registration successful
                const clientInfo = response.body;
                console.log("[Debug OAuth] Client registration successful:", clientInfo);

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: clientInfo.client_id,
                  clientSecret: clientInfo.client_secret,
                  lastResponse: registrationResponseData,
                  httpHistory: updatedHistoryReg,
                  error: undefined,
                  isInitiatingAuth: false,
                });
              }
            } catch (error) {
              console.error("[Debug OAuth] Client registration request failed:", error);

              // Capture the error but continue with fallback
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: {},
                body: { error: error instanceof Error ? error.message : String(error) },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                updatedHistoryError[updatedHistoryError.length - 1].response = errorResponse;
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Client registration failed: ${error instanceof Error ? error.message : String(error)}. Using fallback.`,
              });

              // Fall back to mock client ID
              const fallbackClientId = "preregistered-client-id";
              console.log("[Debug OAuth] Using fallback client ID due to error:", fallbackClientId);

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
            console.log("[Debug OAuth] Generating PKCE parameters");

            // Generate PKCE parameters (simplified for demo)
            const codeVerifier = generateRandomString(43);
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            updateState({
              currentStep: "generate_pkce_parameters",
              codeVerifier,
              codeChallenge,
              codeChallengeMethod: "S256",
              state: generateRandomString(16),
              isInitiatingAuth: false,
            });
            break;

          case "generate_pkce_parameters":
            // Step 8: Build authorization URL
            if (!state.authorizationServerMetadata?.authorization_endpoint || !state.clientId) {
              throw new Error("Missing authorization endpoint or client ID");
            }

            console.log("[Debug OAuth] Building authorization URL");

            const authUrl = new URL(state.authorizationServerMetadata.authorization_endpoint);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", state.clientId);
            authUrl.searchParams.set("redirect_uri", "http://localhost:3000/oauth/callback");
            authUrl.searchParams.set("code_challenge", state.codeChallenge || "");
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("state", state.state || "");
            if (state.serverUrl) {
              authUrl.searchParams.set("resource", state.serverUrl);
            }

            updateState({
              currentStep: "authorization_request",
              authorizationUrl: authUrl.toString(),
              isInitiatingAuth: false,
            });
            break;

          case "authorization_request":
            // Step 9: Simulate authorization code callback
            console.log("[Debug OAuth] Authorization request ready");
            console.log("[Debug OAuth] In production: Browser would redirect to:", state.authorizationUrl);
            console.log("[Debug OAuth] Simulating authorization code callback...");

            // Simulate receiving auth code
            const mockAuthCode = "mock-auth-code-" + Math.random().toString(36).substring(7);

            updateState({
              currentStep: "received_authorization_code",
              authorizationCode: mockAuthCode,
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_code":
            // Step 10: Exchange authorization code for tokens
            if (!state.authorizationServerMetadata?.token_endpoint || !state.authorizationCode) {
              throw new Error("Missing token endpoint or authorization code");
            }

            console.log("[Debug OAuth] Exchanging authorization code for access token");

            const tokenRequest = {
              method: "POST",
              url: state.authorizationServerMetadata.token_endpoint,
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
              },
              body: {
                grant_type: "authorization_code",
                code: state.authorizationCode,
                redirect_uri: "http://localhost:3000/oauth/callback",
                client_id: state.clientId,
                code_verifier: state.codeVerifier,
                resource: state.serverUrl,
              },
            };

            // Update state with the request
            updateState({
              currentStep: "token_request",
              lastRequest: tokenRequest,
              lastResponse: undefined,
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
            // Step 11: Receive access token
            console.log("[Debug OAuth] Receiving access token");

            // Simulate token response
            const mockTokens = {
              access_token: "mock-access-token-" + Math.random().toString(36).substring(7),
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "mock-refresh-token-" + Math.random().toString(36).substring(7),
            };

            const tokenResponseData = {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: mockTokens,
            };

            // Update the last history entry with the response
            const updatedHistoryToken = [...(state.httpHistory || [])];
            if (updatedHistoryToken.length > 0) {
              updatedHistoryToken[updatedHistoryToken.length - 1].response = tokenResponseData;
            }

            updateState({
              currentStep: "received_access_token",
              accessToken: mockTokens.access_token,
              refreshToken: mockTokens.refresh_token,
              tokenType: mockTokens.token_type,
              expiresIn: mockTokens.expires_in,
              lastResponse: tokenResponseData,
              httpHistory: updatedHistoryToken,
              isInitiatingAuth: false,
            });
            break;

          case "received_access_token":
            // Step 12: Make authenticated MCP request
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            console.log("[Debug OAuth] Making authenticated MCP request");

            const authenticatedRequest = {
              method: "POST",
              url: state.serverUrl,
              headers: {
                "Authorization": `Bearer ${state.accessToken}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
              },
              body: {
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
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
            // Step 13: Complete flow
            console.log("[Debug OAuth] OAuth flow complete!");
            console.log("[Debug OAuth] MCP server would process authenticated request");

            // Simulate successful response
            const mcpResponseData = {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: { message: "Authenticated MCP request successful" },
            };

            // Update the last history entry with the response
            const updatedHistoryMcp = [...(state.httpHistory || [])];
            if (updatedHistoryMcp.length > 0) {
              updatedHistoryMcp[updatedHistoryMcp.length - 1].response = mcpResponseData;
            }

            updateState({
              currentStep: "complete",
              lastResponse: mcpResponseData,
              httpHistory: updatedHistoryMcp,
              isInitiatingAuth: false,
            });
            break;

          case "complete":
            // Terminal state
            console.log("[Debug OAuth] Flow is complete");
            updateState({ isInitiatingAuth: false });
            break;

          default:
            console.warn("[Debug OAuth] Unknown step:", state.currentStep);
            updateState({ isInitiatingAuth: false });
            break;
        }
      } catch (error) {
        console.error("[Debug OAuth] Error during step transition:", error);
        updateState({
          error: error instanceof Error ? error.message : String(error),
          isInitiatingAuth: false,
        });
      }
    },

    // Start the guided flow from the beginning
    startGuidedFlow: async () => {
      console.log("[Debug OAuth] Starting guided flow");
      updateState({
        currentStep: "idle",
        isInitiatingAuth: false,
      });
    },

    // Reset the flow to initial state
    resetFlow: () => {
      console.log("[Debug OAuth] Resetting flow");
      updateState({
        ...EMPTY_OAUTH_FLOW_STATE_V2,
        lastRequest: undefined,
        lastResponse: undefined,
        httpHistory: [],
      });
    },
  };

  return machine;
};

// Helper function to generate random string for PKCE
function generateRandomString(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (byte) => charset[byte % charset.length]).join("");
}

// Helper function to generate code challenge from verifier
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

