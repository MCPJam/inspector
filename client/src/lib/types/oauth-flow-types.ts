import {
  OAuthMetadata,
  OAuthClientInformationFull,
  OAuthClientInformation,
  OAuthTokens,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// OAuth protocol versions
export type OAuthProtocolVersion = "2025-06-18" | "2025-11-25";

// OAuth flow steps
export type OAuthStep =
  | "metadata_discovery"
  | "client_registration"
  | "authorization_redirect"
  | "authorization_code"
  | "token_request"
  | "complete";

// Client registration methods
export type RegistrationMethod =
  | "client_id_metadata"
  | "dynamic"
  | "pre_registered";

// Discovery types
export type DiscoveryType = "oauth2" | "oidc";

// Message types for inline feedback
export type MessageType = "success" | "error" | "info";

export interface StatusMessage {
  type: MessageType;
  message: string;
}

// OAuth flow state interface
export interface OAuthFlowState {
  isInitiatingAuth: boolean;
  oauthTokens: OAuthTokens | null;
  oauthStep: OAuthStep;
  resourceMetadata: OAuthProtectedResourceMetadata | null;
  resourceMetadataError: Error | null;
  resource: URL | null;
  authServerUrl: URL | null;
  oauthMetadata: OAuthMetadata | null;
  oauthClientInfo: OAuthClientInformationFull | OAuthClientInformation | null;
  authorizationUrl: string | null;
  authorizationCode: string;
  latestError: Error | null;
  statusMessage: StatusMessage | null;
  validationError: string | null;

  // Protocol version and discovery tracking (added for 2025-11-25 support)
  protocolVersion: OAuthProtocolVersion;
  registrationMethod: RegistrationMethod | null;
  discoveryType: DiscoveryType | null;
  discoveryEndpointUsed: string | null;
  pkceSupported: boolean;
}

export const EMPTY_OAUTH_FLOW_STATE: OAuthFlowState = {
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

  // Protocol version defaults (default to latest 2025-11-25 spec)
  protocolVersion: "2025-11-25",
  registrationMethod: null,
  discoveryType: null,
  discoveryEndpointUsed: null,
  pkceSupported: false,
};

// OAuth flow management interface
export interface OAuthFlowManager {
  state: OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  proceedToNextStep: () => Promise<void>;
  startGuidedFlow: () => Promise<void>;
  resetFlow: () => void;
}
