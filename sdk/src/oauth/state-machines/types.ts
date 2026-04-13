/**
 * Shared types for OAuth state machines
 */

export type MaybePromise<T> = T | Promise<T>;

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
  | "complete"
  | "verify_list_tools"
  | "verify_call_tool";

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
  httpHistory?: Array<HttpHistoryEntry>;

  // Info logs for OAuth flow debugging
  infoLogs?: Array<InfoLogEntry>;

  error?: string;
}

export type InfoLogLevel = "info" | "warning" | "error";

export type LogErrorDetails = {
  message: string;
  details?: unknown;
};

export type InfoLogEntry = {
  id: string;
  step: OAuthFlowStep;
  label: string;
  data: any;
  timestamp: number;
  level: InfoLogLevel;
  error?: LogErrorDetails;
};

export type HttpHistoryEntry = {
  step: OAuthFlowStep;
  timestamp: number; // Request start time
  duration?: number; // Response time in milliseconds
  request: OAuthHttpRequest;
  response?: OAuthHttpResponse;
  error?: LogErrorDetails;
};

export interface OAuthHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

export interface OAuthHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
}

export interface OAuthRequestResult extends OAuthHttpResponse {
  ok: boolean;
}

export type OAuthRequestExecutor = (
  request: OAuthHttpRequest,
) => Promise<OAuthRequestResult>;

export type OAuthAutoAdvanceScheduler = (
  fn: () => void,
  delayMs: number,
) => void;

export interface OAuthDynamicRegistrationMetadata {
  client_name: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  [key: string]: unknown;
}

export interface PreregisteredCredentials {
  clientId?: string;
  clientSecret?: string;
}

export type LoadPreregisteredCredentials = (input: {
  serverName: string;
  serverUrl: string;
}) => MaybePromise<PreregisteredCredentials>;

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
  redirectUrl: string;
  requestExecutor: OAuthRequestExecutor;
  scheduleAutoAdvance?: OAuthAutoAdvanceScheduler;
  loadPreregisteredCredentials?: LoadPreregisteredCredentials;
  dynamicRegistration?: Partial<OAuthDynamicRegistrationMetadata>;
  clientIdMetadataUrl?: string;
  customScopes?: string;
  customHeaders?: Record<string, string>;
}

// Registration strategies
export type RegistrationStrategy2025_03_26 = "dcr" | "preregistered";
export type RegistrationStrategy2025_06_18 = "dcr" | "preregistered";
export type RegistrationStrategy2025_11_25 = "cimd" | "dcr" | "preregistered";

// Protocol versions
export type OAuthProtocolVersion = "2025-03-26" | "2025-06-18" | "2025-11-25";
