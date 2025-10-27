// OAuth flow steps based on MCP specification
export type OAuthFlowStep =
  | "idle"
  | "request_resource_metadata"
  | "received_resource_metadata"
  | "request_authorization_server_metadata"
  | "received_authorization_server_metadata"
  // Add more steps here as needed
  ;

// State interface for OAuth flow
export interface OauthFlowStateNovember2025 {
  isInitiatingAuth: boolean;
  currentStep: OAuthFlowStep;
  // Data collected during the flow
  serverUrl?: string;
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
  error?: string;
  // Add more state properties here as needed
}

// Initial empty state
export const EMPTY_OAUTH_FLOW_STATE_V2: OauthFlowStateNovember2025 = {
  isInitiatingAuth: false,
  currentStep: "idle",
};

// State machine interface
export interface DebugOAuthStateMachine {
  state: OauthFlowStateNovember2025;
  updateState: (updates: Partial<OauthFlowStateNovember2025>) => void;
  proceedToNextStep: () => Promise<void>;
  startGuidedFlow: () => Promise<void>;
  resetFlow: () => void;
}

// Configuration for creating the state machine
export interface DebugOAuthStateMachineConfig {
  state: OauthFlowStateNovember2025;
  updateState: (updates: Partial<OauthFlowStateNovember2025>) => void;
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
            // Step 1: Request Protected Resource Metadata directly
            // (SDK skips the 401 response and goes straight to well-known URI)
            const resourceMetadataUrl = buildResourceMetadataUrl(serverUrl);
            console.log("[Debug OAuth] Requesting resource metadata from:", resourceMetadataUrl);

            updateState({
              currentStep: "request_resource_metadata",
              serverUrl,
              resourceMetadataUrl,
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
              const response = await fetchFn(state.resourceMetadataUrl, {
                method: "GET",
                headers: {
                  "Accept": "application/json",
                },
              });

              if (!response.ok) {
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

              updateState({
                currentStep: "received_resource_metadata",
                resourceMetadata,
                authorizationServerUrl,
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

            updateState({
              currentStep: "request_authorization_server_metadata",
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

            for (const url of urlsToTry) {
              try {
                console.log("[Debug OAuth] Trying:", url);
                const response = await fetchFn(url, {
                  method: "GET",
                  headers: {
                    "Accept": "application/json",
                  },
                });

                if (response.ok) {
                  authServerMetadata = await response.json();
                  console.log("[Debug OAuth] Found authorization server metadata at:", url);
                  console.log("[Debug OAuth] Metadata:", authServerMetadata);
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

            if (!authServerMetadata) {
              throw new Error(`Could not discover authorization server metadata. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
            }

            updateState({
              currentStep: "received_authorization_server_metadata",
              authorizationServerMetadata: authServerMetadata,
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
      });
    },
  };
};


