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
