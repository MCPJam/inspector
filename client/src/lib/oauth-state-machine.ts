import { OAuthStep, OAuthFlowState } from "./oauth-flow-types";
import {
  discoverOAuthMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  discoverOAuthProtectedResourceMetadata,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { DebugMCPOAuthClientProvider } from "./debug-oauth-provider";

export interface StateMachineContext {
  state: OAuthFlowState;
  serverUrl: string;
  serverName: string;
  provider: DebugMCPOAuthClientProvider;
  updateState: (updates: Partial<OAuthFlowState>) => void;
}

export interface StateTransition {
  canTransition: (context: StateMachineContext) => Promise<boolean>;
  execute: (context: StateMachineContext) => Promise<void>;
}

// State machine transitions
export const oauthTransitions: Record<OAuthStep, StateTransition> = {
  metadata_discovery: {
    canTransition: async () => true,
    execute: async (context) => {
      try {
        context.updateState({ latestError: null });

        // Validate server URL first
        if (!context.serverUrl) {
          throw new Error("Server URL is required");
        }

        let serverUrl: string;
        try {
          // Ensure we have a valid URL
          const url = new URL(context.serverUrl);
          serverUrl = url.toString();
        } catch (e) {
          throw new Error(`Invalid server URL: ${context.serverUrl}`);
        }

        // Default to discovering from the server's URL
        let authServerUrl: URL;
        try {
          authServerUrl = new URL("/", serverUrl);
        } catch (e) {
          throw new Error(
            `Failed to create base URL from server URL: ${serverUrl}`,
          );
        }

        let resourceMetadata = null;
        let resourceMetadataError = null;

        try {
          resourceMetadata =
            await discoverOAuthProtectedResourceMetadata(serverUrl);
          if (resourceMetadata?.authorization_servers?.length) {
            const authServerUrlString =
              resourceMetadata.authorization_servers[0];
            try {
              authServerUrl = new URL(authServerUrlString);
            } catch (e) {
              // Keep the default authServerUrl
            }
          }
        } catch (e) {
          resourceMetadataError = e instanceof Error ? e : new Error(String(e));
        }

        // Discover OAuth metadata from the authorization server
        const oauthMetadata = await discoverOAuthMetadata(
          authServerUrl.toString(),
        );

        // Optionally select a protected resource URL (if server provides resource metadata)
        let resource: URL | null = null;
        try {
          const selected = await selectResourceURL(
            serverUrl,
            context.provider,
            resourceMetadata ?? undefined,
          );
          resource = selected ?? null;
        } catch (e) {
          // Non-fatal; continue without resource
        }

        context.updateState({
          resourceMetadata,
          resourceMetadataError,
          resource,
          authServerUrl,
          oauthMetadata,
          oauthStep: "client_registration",
        });
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        context.updateState({
          latestError: errorObj,
          statusMessage: {
            type: "error",
            message: `Metadata discovery failed: ${errorObj.message}`,
          },
        });
      }
    },
  },

  client_registration: {
    canTransition: async (context) => !!context.state.oauthMetadata,
    execute: async (context) => {
      try {
        context.updateState({ latestError: null });

        if (!context.state.oauthMetadata) {
          throw new Error("OAuth metadata not available");
        }

        // Try to use the proper MCP SDK registerClient function
        let clientInfo;

        try {
          // Prepare client metadata, including supported scopes if advertised
          const clientMetadata = { ...context.provider.clientMetadata } as any;
          const scopesSupported =
            context.state.resourceMetadata?.scopes_supported ||
            context.state.oauthMetadata.scopes_supported;
          if (scopesSupported && scopesSupported.length > 0) {
            clientMetadata.scope = scopesSupported.join(" ");
          }
          try {
            clientInfo = await registerClient(context.serverUrl, {
              metadata: context.state.oauthMetadata,
              clientMetadata,
            });
            context.provider.saveClientInformation(clientInfo);
          } catch (dcrError) {
            // DCR failed, fallback to preregistered client
            clientInfo = await context.provider.clientInformation();
            if (!clientInfo) {
              throw dcrError;
            }
          }
        } catch (registrationError) {
          // Fallback to using static client metadata if dynamic registration fails
          const existingClientInfo = await context.provider.clientInformation();
          if (existingClientInfo) {
            clientInfo = existingClientInfo;
          } else {
            // Create a mock client info based on the provider's metadata
            clientInfo = {
              client_id: `static_client_${Date.now()}`,
              ...context.provider.clientMetadata,
            };
            context.provider.saveClientInformation(clientInfo);
          }
        }

        context.updateState({
          oauthClientInfo: clientInfo,
          oauthStep: "authorization_redirect",
          statusMessage: {
            type: "success",
            message: "Client registration completed successfully.",
          },
        });
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        context.updateState({
          latestError: errorObj,
          statusMessage: {
            type: "error",
            message: `Client registration failed: ${errorObj.message}`,
          },
        });
      }
    },
  },

  authorization_redirect: {
    canTransition: async (context) =>
      !!context.state.oauthMetadata && !!context.state.oauthClientInfo,
    execute: async (context) => {
      try {
        context.updateState({ latestError: null });

        if (!context.state.oauthMetadata || !context.state.oauthClientInfo) {
          throw new Error("OAuth metadata or client info not available");
        }

        // Compute scope based on advertised scopes if available
        const scopesSupported =
          context.state.resourceMetadata?.scopes_supported ||
          context.state.oauthMetadata.scopes_supported;
        const scope =
          scopesSupported && scopesSupported.length > 0
            ? scopesSupported.join(" ")
            : undefined;

        // Generate a random state for CSRF protection
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const state = Array.from(array, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");

        const authResult = await startAuthorization(context.serverUrl, {
          metadata: context.state.oauthMetadata,
          clientInformation: context.state.oauthClientInfo,
          redirectUrl: context.provider.redirectUrl,
          scope,
          state,
          resource: context.state.resource ?? undefined,
        });

        // Save the code verifier for later use in token exchange
        context.provider.saveCodeVerifier(authResult.codeVerifier);

        context.updateState({
          authorizationUrl: authResult.authorizationUrl.toString(),
          oauthStep: "authorization_code",
          statusMessage: {
            type: "info",
            message:
              "Authorization URL generated. Please complete authorization in your browser.",
          },
        });
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        context.updateState({
          latestError: errorObj,
          statusMessage: {
            type: "error",
            message: `Authorization preparation failed: ${errorObj.message}`,
          },
        });
      }
    },
  },

  authorization_code: {
    canTransition: async (context) => !!context.state.authorizationCode.trim(),
    execute: async (context) => {
      try {
        context.updateState({ latestError: null, validationError: null });

        if (!context.state.authorizationCode.trim()) {
          context.updateState({
            validationError: "Authorization code is required",
          });
          return;
        }

        context.updateState({ oauthStep: "token_request" });
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        context.updateState({
          latestError: errorObj,
          validationError: errorObj.message,
        });
      }
    },
  },

  token_request: {
    canTransition: async (context) =>
      !!context.state.authorizationCode.trim() && !!context.state.oauthMetadata,
    execute: async (context) => {
      try {
        context.updateState({ latestError: null });

        if (
          !context.state.oauthMetadata ||
          !context.state.authorizationCode.trim() ||
          !context.state.oauthClientInfo
        ) {
          throw new Error(
            "OAuth metadata, authorization code, or client info not available",
          );
        }

        const tokens = await exchangeAuthorization(context.serverUrl, {
          metadata: context.state.oauthMetadata,
          clientInformation: context.state.oauthClientInfo,
          authorizationCode: context.state.authorizationCode,
          codeVerifier: context.provider.codeVerifier(),
          redirectUri: context.provider.redirectUrl,
        });

        context.updateState({
          oauthTokens: tokens,
          oauthStep: "complete",
          statusMessage: {
            type: "success",
            message: "OAuth authentication completed successfully!",
          },
        });
      } catch (error) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        context.updateState({
          latestError: errorObj,
          statusMessage: {
            type: "error",
            message: `Token exchange failed: ${errorObj.message}`,
          },
        });
      }
    },
  },

  complete: {
    canTransition: async () => false, // Terminal state
    execute: async () => {
      // Nothing to do, already complete
    },
  },
};

export class OAuthStateMachine {
  constructor(private context: StateMachineContext) {}

  async proceedToNextStep(): Promise<boolean> {
    const currentStep = this.context.state.oauthStep;
    const transition = oauthTransitions[currentStep];

    if (!transition) {
      return false;
    }

    try {
      this.context.updateState({ isInitiatingAuth: true });

      const canTransition = await transition.canTransition(this.context);
      if (!canTransition) {
        return false;
      }

      await transition.execute(this.context);
      return true;
    } catch (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      this.context.updateState({
        latestError: errorObj,
        statusMessage: {
          type: "error",
          message: errorObj.message,
        },
      });
      return false;
    } finally {
      this.context.updateState({ isInitiatingAuth: false });
    }
  }

  reset(): void {
    this.context.updateState({
      isInitiatingAuth: false,
      oauthTokens: null,
      oauthStep: "metadata_discovery",
      oauthMetadata: null,
      resourceMetadata: null,
      resourceMetadataError: null,
      resource: null,
      authServerUrl: null,
      oauthClientInfo: null,
      authorizationUrl: null,
      authorizationCode: "",
      latestError: null,
      statusMessage: null,
      validationError: null,
    });
  }
}
