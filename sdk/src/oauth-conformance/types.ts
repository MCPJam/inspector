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
}

export interface StepResult {
  step: OAuthFlowStep;
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
  verification?: VerificationResult;
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
