// OAuth flow steps based on MCP specification
export type OAuthFlowStep =
  | "idle"
  | "sent_unauthenticated_request"
  | "received_401_www_authenticate"
  // Add more steps here as needed
  ;

// State interface for OAuth flow
export interface OauthFlowStateNovember2025 {
  isInitiatingAuth: boolean;
  currentStep: OAuthFlowStep;
  // Data collected during the flow
  serverUrl?: string;
  wwwAuthenticateHeader?: string;
  authorizationServer?: string;
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
}

// Factory function to create the state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig
): DebugOAuthStateMachine => {
  const { state, updateState, serverUrl, serverName } = config;

  return {
    state,
    updateState,

    // Proceed to next step in the flow
    proceedToNextStep: async () => {
      console.log("[Debug OAuth] Proceeding to next step from:", state.currentStep);

      updateState({ isInitiatingAuth: true });

      try {
        switch (state.currentStep) {
          case "idle":
            // Step 1: Send an unauthenticated request
            console.log("[Debug OAuth] Sending unauthenticated request to:", serverUrl);
            await new Promise(resolve => setTimeout(resolve, 500)); // Simulate network delay
            updateState({
              currentStep: "sent_unauthenticated_request",
              serverUrl,
              isInitiatingAuth: false,
            });
            break;

          case "sent_unauthenticated_request":
            // Step 2: Receive 401 with WWW-Authenticate header
            console.log("[Debug OAuth] Received 401 response with WWW-Authenticate header");
            await new Promise(resolve => setTimeout(resolve, 500)); // Simulate network delay

            // Simulate the WWW-Authenticate header response
            const wwwAuthenticateHeader = `Bearer authorization_uri="${serverUrl}/oauth/authorize"`;
            updateState({
              currentStep: "received_401_www_authenticate",
              wwwAuthenticateHeader,
              authorizationServer: `${serverUrl}/oauth/authorize`,
              isInitiatingAuth: false,
            });
            break;

          case "received_401_www_authenticate":
            // TODO: Implement next steps here
            console.log("[Debug OAuth] Parsed authorization server:", state.authorizationServer);
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


