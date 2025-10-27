// OAuth flow steps based on MCP specification
export type OAuthFlowStep =
  | "idle"
  | "request_without_token"
  | "received_401_unauthorized"
  | "extract_resource_metadata_url"
  | "request_resource_metadata"
  | "received_resource_metadata"
  | "request_authorization_server_metadata"
  | "received_authorization_server_metadata"
  // Add more steps here as needed
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
  // Raw request/response data for debugging
  lastRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
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

// Factory function to create the state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig
): DebugOAuthStateMachine => {
  const { state, updateState, serverUrl, serverName, fetchFn = fetch } = config;

  return {
    state,
    updateState,

    // Proceed to next step in the flow (matches SDK's actual approach)
    proceedToNextStep: async () => {
      console.log("[Debug OAuth] Proceeding to next step from:", state.currentStep);

      updateState({ isInitiatingAuth: true });

      try {
        switch (state.currentStep) {
          case "idle":
            // Step 1: Make initial MCP request without token
            console.log("[Debug OAuth] Making initial request to MCP server without token");

            const initialRequest = {
              method: "GET",
              url: serverUrl,
              headers: {
                "Accept": "application/json",
              },
            };

            updateState({
              currentStep: "request_without_token",
              serverUrl,
              lastRequest: initialRequest,
              lastResponse: undefined, // Clear any previous response
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_without_token",
                  request: initialRequest,
                },
              ],
              isInitiatingAuth: false,
            });
            break;

          case "request_without_token":
            // Step 2: Request MCP server and expect 401 Unauthorized
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            console.log("[Debug OAuth] Requesting MCP server at:", state.serverUrl);

            try {
              const requestHeaders = {
                "Accept": "application/json",
              };

              const response = await fetchFn(state.serverUrl, {
                method: "GET",
                headers: requestHeaders,
              });

              // Capture response headers
              const responseHeaders: Record<string, string> = {};
              response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
              });

              if (response.status === 401) {
                // Expected 401 response with WWW-Authenticate header
                const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate");
                console.log("[Debug OAuth] Received 401 Unauthorized");
                console.log("[Debug OAuth] WWW-Authenticate header:", wwwAuthenticateHeader);

                const responseData = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: responseHeaders,
                  body: null,
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
            // Step 3: Extract resource metadata URL from WWW-Authenticate header
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

            updateState({
              currentStep: "extract_resource_metadata_url",
              resourceMetadataUrl: extractedResourceMetadataUrl,
              isInitiatingAuth: false,
            });
            break;

          case "extract_resource_metadata_url":
            // Step 4: Transition to request resource metadata
            if (!state.resourceMetadataUrl) {
              throw new Error("No resource metadata URL available");
            }

            console.log("[Debug OAuth] Proceeding to request resource metadata from:", state.resourceMetadataUrl);

            const resourceMetadataRequest = {
              method: "GET",
              url: state.resourceMetadataUrl,
              headers: {
                "Accept": "application/json",
              },
            };

            updateState({
              currentStep: "request_resource_metadata",
              lastRequest: resourceMetadataRequest,
              lastResponse: undefined, // Clear previous response
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_resource_metadata",
                  request: resourceMetadataRequest,
                },
              ],
              isInitiatingAuth: false,
            });
            break;

          case "request_resource_metadata":
            // Step 2: Fetch and parse resource metadata
            if (!state.resourceMetadataUrl) {
              throw new Error("No resource metadata URL available");
            }

            console.log("[Debug OAuth] Fetching resource metadata from:", state.resourceMetadataUrl);

            try {
              const requestHeaders = {
                "Accept": "application/json",
              };

              const response = await fetchFn(state.resourceMetadataUrl, {
                method: "GET",
                headers: requestHeaders,
              });

              // Capture response headers
              const responseHeaders: Record<string, string> = {};
              response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
              });

              if (!response.ok) {
                // Capture failed response
                const failedResponseData = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: responseHeaders,
                  body: null,
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

              const resourceMetadata = await response.json();
              console.log("[Debug OAuth] Received resource metadata:", resourceMetadata);

              // Extract authorization server URL (use first one if multiple, fallback to server URL)
              const authorizationServerUrl = resourceMetadata.authorization_servers?.[0] || serverUrl;
              console.log("[Debug OAuth] Authorization server URL:", authorizationServerUrl);

              const successResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
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

            updateState({
              currentStep: "request_authorization_server_metadata",
              lastRequest: authServerRequest,
              lastResponse: undefined, // Clear previous response
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_authorization_server_metadata",
                  request: authServerRequest,
                },
              ],
              isInitiatingAuth: false,
            });
            break;

          case "request_authorization_server_metadata":
            // Step 4: Fetch authorization server metadata (try multiple endpoints)
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const urlsToTry = buildAuthServerMetadataUrls(state.authorizationServerUrl);
            let authServerMetadata = null;
            let lastError = null;
            let successUrl = "";
            let finalRequestHeaders = {};
            let finalResponseHeaders: Record<string, string> = {};
            let finalResponse: Response | null = null;

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

                const response = await fetchFn(url, {
                  method: "GET",
                  headers: requestHeaders,
                });

                if (response.ok) {
                  authServerMetadata = await response.json();
                  console.log("[Debug OAuth] Found authorization server metadata at:", url);
                  console.log("[Debug OAuth] Metadata:", authServerMetadata);
                  successUrl = url;
                  finalRequestHeaders = requestHeaders;
                  finalResponse = response;

                  // Capture response headers
                  response.headers.forEach((value, key) => {
                    finalResponseHeaders[key] = value;
                  });

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

            if (!authServerMetadata || !finalResponse) {
              throw new Error(`Could not discover authorization server metadata. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
            }

            const authServerResponseData = {
              status: finalResponse.status,
              statusText: finalResponse.statusText,
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
            // Terminal state for now
            console.log("[Debug OAuth] OAuth flow discovery complete!");
            console.log("[Debug OAuth] Next steps: Client registration, authorization redirect, token exchange");
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
};


