import type {
  InfoLogEntry,
  HttpHistoryEntry,
  OAuthDynamicRegistrationMetadata,
  OAuthFlowStep,
  OAuthHttpRequest,
  OAuthProtocolVersion,
  OAuthRequestResult,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "../oauth/state-machines/types.js";
import type { OAuthStepInfo } from "../oauth/state-machines/shared/step-metadata.js";

// ── Conformance-only check identifiers ────────────────────────────────
// These are post-flow validation checks that do NOT belong in OAuthFlowStep
// (the interactive debugger state machine never enters these states).

export type OAuthConformanceCheckId =
  | "oauth_dcr_http_redirect_uri"
  | "oauth_invalid_client"
  | "oauth_invalid_authorize_redirect"
  | "oauth_invalid_token"
  | "oauth_invalid_redirect"
  | "oauth_token_format";

/** A step in a conformance result: either a real flow step or a post-flow check. */
export type ConformanceStepId = OAuthFlowStep | OAuthConformanceCheckId;

export const CONFORMANCE_CHECK_METADATA: Record<
  OAuthConformanceCheckId,
  OAuthStepInfo
> = {
  oauth_dcr_http_redirect_uri: {
    title: "OAuth Check: DCR Redirect URI Policy",
    summary:
      "Attempt dynamic client registration with a non-loopback http redirect URI and confirm the authorization server rejects it.",
    teachableMoments: [
      "MCP authorization requires redirect URIs to use localhost or HTTPS.",
    ],
  },
  oauth_invalid_client: {
    title: "OAuth Check: Invalid Client",
    summary:
      "Send a token request with an invalid client identifier and confirm the authorization server rejects it.",
    teachableMoments: [
      "Authorization servers should reject malformed or unknown clients instead of issuing tokens.",
    ],
  },
  oauth_invalid_authorize_redirect: {
    title: "OAuth Check: Invalid Redirect URI at Authorization Endpoint",
    summary:
      "Send an authorization request with a mismatched redirect URI and confirm the authorization server refuses to redirect back to it.",
    teachableMoments: [
      "Authorization servers should validate redirect_uri before redirecting user agents to untrusted callback URLs.",
    ],
  },
  oauth_invalid_token: {
    title: "OAuth Check: Invalid Access Token",
    summary:
      "Send an authenticated MCP initialize request with an obviously invalid bearer token and confirm the MCP server returns HTTP 401.",
    teachableMoments: [
      "Resource servers must reject invalid bearer tokens with HTTP 401 instead of treating them as authenticated.",
    ],
  },
  oauth_invalid_redirect: {
    title: "OAuth Check: Invalid Redirect URI",
    summary:
      "Send a token request with a mismatched redirect URI and look for a redirect-specific rejection from the token endpoint.",
    teachableMoments: [
      "A generic invalid_grant rejection does not prove redirect URI exact-match validation.",
    ],
  },
  oauth_token_format: {
    title: "OAuth Check: Token Response Format",
    summary:
      "Validate that the successful token response includes the expected access token fields.",
    teachableMoments: [
      "Token responses should include a usable bearer token, token type, and expiration metadata.",
    ],
  },
};

export type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export type OAuthPublicClientMetadata = OAuthDynamicRegistrationMetadata;

export type OAuthConformanceAuthConfig =
  | {
      mode: "interactive";
      openUrl?: (url: string) => Promise<void>;
    }
  | {
      mode: "headless";
    }
  | {
      mode: "client_credentials";
      clientId: string;
      clientSecret: string;
    };

export interface OAuthConformanceClientConfig {
  preregistered?: {
    clientId: string;
    clientSecret?: string;
  };
  dynamicRegistration?: Partial<OAuthPublicClientMetadata>;
  clientIdMetadataUrl?: string;
}

export interface OAuthConformanceConfig {
  serverUrl: string;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  auth?: OAuthConformanceAuthConfig;
  client?: OAuthConformanceClientConfig;
  scopes?: string;
  customHeaders?: Record<string, string>;
  redirectUrl?: string;
  fetchFn?: typeof fetch;
  stepTimeout?: number;
  verification?: OAuthVerificationConfig;
  oauthConformanceChecks?: boolean;
  /** Optional callback for progress messages during the OAuth flow. */
  onProgress?: (message: string) => void;
}

export interface StepResult {
  step: ConformanceStepId;
  title: string;
  summary: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  logs: InfoLogEntry[];
  http?: HttpHistoryEntry;
  httpAttempts: HttpHistoryEntry[];
  error?: {
    message: string;
    details?: unknown;
  };
  teachableMoments?: string[];
}

export interface ConformanceResult {
  passed: boolean;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  serverUrl: string;
  steps: StepResult[];
  summary: string;
  durationMs: number;
  credentials?: OAuthConformanceCredentials;
  verification?: VerificationResult;
}

export interface OAuthConformanceCredentials {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

export interface NormalizedOAuthConformanceConfig {
  serverUrl: string;
  serverName: string;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  auth: OAuthConformanceAuthConfig;
  client: OAuthConformanceClientConfig;
  scopes?: string;
  customHeaders?: Record<string, string>;
  redirectUrl?: string;
  fetchFn: typeof fetch;
  stepTimeout: number;
  verification: OAuthVerificationConfig;
  oauthConformanceChecks: boolean;
  onProgress: (message: string) => void;
}

export interface TrackedRequestOptions {
  redirect?: RequestRedirect;
}

export type TrackedRequestFn = (
  request: OAuthHttpRequest,
  options?: TrackedRequestOptions,
) => Promise<OAuthRequestResult>;

export interface AuthorizationCodeResult {
  code: string;
}

export interface ClientCredentialsResult {
  tokenResponse: OAuthRequestResult;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

// ── Verification ──────────────────────────────────────────────────────

/** Optional post-auth verification: connect to the MCP server and exercise tools. */
export interface OAuthVerificationConfig {
  /** After successful OAuth, connect and call tools/list. Default: false. */
  listTools?: boolean;
  /** Also call the named tool with the given params after listing. */
  callTool?: {
    name: string;
    params?: Record<string, unknown>;
  };
  /** Timeout for verification steps in ms. Default: 30_000. */
  timeout?: number;
}

export interface VerificationResult {
  listTools?: {
    passed: boolean;
    toolCount?: number;
    durationMs: number;
    error?: string;
  };
  callTool?: {
    passed: boolean;
    toolName: string;
    durationMs: number;
    error?: string;
  };
}

export interface OAuthConformanceStepExecution {
  step: ConformanceStepId;
  status: StepResult["status"];
  durationMs: number;
  httpAttempts: HttpHistoryEntry[];
  error?: StepResult["error"];
}

// ── Suite ─────────────────────────────────────────────────────────────

/** Shared default fields — all optional so they can be selectively overridden. */
export type OAuthConformanceSuiteDefaults = Partial<
  Omit<OAuthConformanceConfig, "serverUrl">
>;

/** Per-flow config — may omit fields provided by defaults. */
export type OAuthConformanceSuiteFlow = Partial<
  Omit<OAuthConformanceConfig, "serverUrl">
> & {
  /** Optional label for this flow (used in reporting). */
  label?: string;
};

/** Config for running multiple conformance flows against one server. */
export interface OAuthConformanceSuiteConfig {
  /** Human-friendly name for the suite run. */
  name?: string;
  /** The MCP server URL. Shared across all flows. */
  serverUrl: string;
  /** Shared defaults applied to each flow unless overridden. */
  defaults?: OAuthConformanceSuiteDefaults;
  /** Each entry defines one flow in the matrix. Properties override defaults. */
  flows: OAuthConformanceSuiteFlow[];
}

/** Result for the entire suite run. */
export interface OAuthConformanceSuiteResult {
  name: string;
  serverUrl: string;
  passed: boolean;
  results: Array<ConformanceResult & { label: string }>;
  summary: string;
  durationMs: number;
}
