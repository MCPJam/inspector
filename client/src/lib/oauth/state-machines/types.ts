/**
 * Shared types for OAuth state machines
 */

// OAuth flow steps based on MCP specification
export type OAuthFlowStep =
  | "idle"
  | "request_without_token"
  | "received_401_unauthorized"
  | "discovery_start" // 2025-03-26 spec: Start discovery from MCP server URL
  | "request_resource_metadata"
  | "received_resource_metadata"
  | "request_authorization_server_metadata"
  | "received_authorization_server_metadata"
  // CIMD steps (2025-11-25 spec)
  | "cimd_prepare"
  | "cimd_fetch_request"
  | "cimd_metadata_response"
  // Client registration steps
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
export interface OAuthFlowState {
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
    // 2025-11-25 additions
    client_id_metadata_document_supported?: boolean;
  };

  // Client Registration
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;

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
    body: any;
  };

  // History of all request/response pairs
  httpHistory?: Array<{
    step: OAuthFlowStep;
    timestamp: number; // Request start time
    duration?: number; // Response time in milliseconds
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
}

// Initial empty state
export const EMPTY_OAUTH_FLOW_STATE: OAuthFlowState = {
  isInitiatingAuth: false,
  currentStep: "idle",
  httpHistory: [],
  infoLogs: [],
  tokenEndpointAuthMethod: undefined,
};

// State machine interface
export interface OAuthStateMachine {
  state: OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  proceedToNextStep: () => Promise<void>;
  startGuidedFlow: () => Promise<void>;
  resetFlow: () => void;
}

// Base configuration for state machines
export interface BaseOAuthStateMachineConfig {
  state: OAuthFlowState;
  getState?: () => OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  serverUrl: string;
  serverName: string;
  redirectUrl?: string;
  fetchFn?: typeof fetch;
  customScopes?: string;
  customHeaders?: Record<string, string>;
}

// Registration strategies
export type RegistrationStrategy2025_03_26 = "dcr" | "preregistered";
export type RegistrationStrategy2025_06_18 = "dcr" | "preregistered";
export type RegistrationStrategy2025_11_25 = "cimd" | "dcr" | "preregistered";

// Protocol versions
export type OAuthProtocolVersion = "2025-03-26" | "2025-06-18" | "2025-11-25";
