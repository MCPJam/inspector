import type {
  InfoLogLevel,
  LogErrorDetails,
} from "../../oauth/state-machines/types.js";
import {
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  DEFAULT_NEGATIVE_TEST_MODE,
  DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  type IdentityAssertionFormat,
  type NegativeTestMode,
  type SubjectIdentifierFormat,
} from "../constants.js";
import type { XAACompatibilityReport } from "./capability-preflight.js";

export type XAAFlowStep =
  | "idle"
  | "discover_resource_metadata"
  | "received_resource_metadata"
  | "discover_authz_metadata"
  | "received_authz_metadata"
  | "request_client_registration"
  | "received_client_credentials"
  | "fetch_client_metadata_document"
  | "received_client_metadata"
  | "user_authentication"
  | "received_identity_assertion"
  | "token_exchange_request"
  | "received_id_jag"
  | "inspect_id_jag"
  | "jwt_bearer_request"
  | "received_access_token"
  | "authenticated_mcp_request"
  | "complete";

/** How the flow's client identity at the target AS is established.
 * `preregistered` (default) = user-supplied credentials, today's behavior.
 * `dcr` = open RFC 7591 registration (no initial access token).
 * `cimd` = MCPJam's hosted Client ID Metadata Document URL as the client_id.
 * Canonical definition + normalizer live in ../../registration.ts — the
 * vocabulary shared with the OAuth flows. */
import type { RegistrationStrategy } from "../../registration.js";
export type { RegistrationStrategy };

/** Token-endpoint client-auth methods the debugger can actually redeem. */
export type XaaTokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none";

export type XaaRegistrationWarningCode =
  | "public_client"
  | "profile_metadata_not_echoed"
  | "grant_types_not_echoed"
  | "token_exchange_grant_not_echoed"
  | "auth_method_not_echoed"
  | "missing_secret_expiry"
  | "non_201_success"
  | "non_json_content_type"
  | "missing_no_store";

/** Non-blocking readiness/conformance finding from DCR or CIMD setup.
 * Never carries credential material. */
export interface XaaRegistrationWarning {
  code: XaaRegistrationWarningCode;
  message: string;
}

/** DCR-minted credentials. Live only in the target-scoped in-memory session
 * cache — never in XAAFlowState, storage, history, or logs. */
export interface XaaEphemeralDcrCredentials {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  /** RFC 7591 client_secret_expires_at (seconds since epoch; 0 = never). */
  clientSecretExpiresAt?: number;
  registrationEndpoint: string;
}

export interface XaaDcrCredentialCache {
  get(key: string): XaaEphemeralDcrCredentials | undefined;
  set(key: string, value: XaaEphemeralDcrCredentials): void;
  delete(key: string): void;
}

export interface XAAJWTInspectionIssue {
  section: "header" | "payload" | "signature";
  field: string;
  label: string;
  expected: string;
  actual: string;
}

export interface XAADecodedJwt {
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  signature: string;
  issues: XAAJWTInspectionIssue[];
}

export interface XAAInfoLogEntry {
  id: string;
  step: XAAFlowStep;
  label: string;
  data: any;
  timestamp: number;
  level: InfoLogLevel;
  error?: LogErrorDetails;
}

export interface XAAHttpHistoryEntry {
  step: XAAFlowStep;
  timestamp: number;
  duration?: number;
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
  error?: LogErrorDetails;
}

export interface XAAFlowState {
  isBusy: boolean;
  currentStep: XAAFlowStep;
  serverUrl?: string;
  resourceUrl?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: {
    resource?: string;
    authorization_servers?: string[];
    bearer_methods_supported?: string[];
    scopes_supported?: string[];
  };
  authzServerIssuer?: string;
  authzMetadata?: {
    issuer: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    grant_types_supported?: string[];
    response_types_supported?: string[];
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    authorization_grant_profiles_supported?: string[];
    client_id_metadata_document_supported?: boolean;
  };
  tokenEndpoint?: string;
  /** The mock IdP issuer expected in the ID-JAG `iss` claim. */
  issuerBaseUrl?: string;
  negativeTestMode: NegativeTestMode;
  /** Input axis: assertion format the mock IdP mints and the exchange
   * presents. Sticky like negativeTestMode — the UI resets the flow to
   * change it. */
  identityAssertionFormat: IdentityAssertionFormat;
  /** Output axis: whether the ID-JAG carries a saml-nameid `sub_id`. Sticky
   * like negativeTestMode. Independent of the input axis. */
  subjectIdentifierFormat: SubjectIdentifierFormat;
  /** Structured subject metadata from a SAML `/authenticate` response, for
   * UI display — the client never parses assertion XML. */
  identityAssertionSubject?: {
    issuer: string;
    nameid: string;
    nameidFormat?: string;
    spNameQualifier?: string;
  };
  userId?: string;
  email?: string;
  clientId?: string;
  /** Test-credential secret for the jwt-bearer grant; never rendered — the
   * logged copy of any request carrying it is masked. */
  clientSecret?: string;
  scope?: string;
  identityAssertion?: string;
  idJag?: string;
  idJagDecoded?: XAADecodedJwt | null;
  accessToken?: string;
  tokenType?: string;
  expiresIn?: number;
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
  httpHistory?: Array<XAAHttpHistoryEntry>;
  infoLogs?: Array<XAAInfoLogEntry>;
  error?: string;
  /** Outcome of a deliberately-broken (negative-mode) run once it reaches the
   * authorization server. `rejected` is the success case — the server caught
   * the broken assertion; `accepted` is the security risk — it issued a token
   * anyway. Unset for the happy-path (valid) flow. */
  negativeProbe?: { outcome: "rejected" | "accepted"; status?: number };
  compatibilityReport?: XAACompatibilityReport;
  /** How this run's client identity is established. Authoritative once the
   * machine is initialized — the UI must reset the flow to change it. */
  registrationStrategy: RegistrationStrategy;
  /** How the jwt-bearer redemption authenticates at the token endpoint.
   * Unset = legacy body-post behavior. */
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  /** True when a DCR run reused this browser session's earlier registration
   * instead of POSTing again. */
  dcrRegistrationReused?: boolean;
  /** Non-blocking readiness/conformance findings from DCR/CIMD setup. */
  registrationWarnings?: XaaRegistrationWarning[];
  /** Set after a DCR POST whose outcome left no reusable registration: a
   * retry may create a second remote client and needs explicit confirmation. */
  dcrRetryMayCreateDuplicate?: boolean;
}

export interface XAARequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
}

export interface XAAExternalRequestOptions {
  /** Enforce the private-host / DNS-resolution SSRF guard for this request at
   * fetch time, regardless of the executor's `httpsOnly` default. Used for the
   * caller-influenced CIMD document fetch, which must always target a public
   * host — closing the DNS-rebinding window a one-time upstream check leaves. */
  enforcePublicHost?: boolean;
}

export interface XAARequestExecutor {
  internalRequest: (
    path: string,
    init?: RequestInit
  ) => Promise<XAARequestResult>;
  externalRequest: (
    url: string,
    init?: RequestInit,
    options?: XAAExternalRequestOptions
  ) => Promise<XAARequestResult>;
}

export interface BaseXAAStateMachineConfig {
  /** Initial state. Optional — prefer `getState` so the machine never holds a
   * stale snapshot read during render. */
  state?: XAAFlowState;
  getState?: () => XAAFlowState;
  updateState: (updates: Partial<XAAFlowState>) => void;
  serverUrl: string;
  issuerBaseUrl: string;
  /** Path prefix for the mint endpoints (`/authenticate`, `/token-exchange`),
   * e.g. `/o/<orgId>` for the hosted org-scoped issuer. Never applied to the
   * token proxy, which has no scoped variant. Defaults to "" (unscoped). */
  mintPathPrefix?: string;
  /** LOCAL runs only: "hosted" adds `issuerMode`/`organizationId` to the mint
   * request bodies so the local server forwards them to the hosted issuer. */
  issuerMode?: "local" | "hosted";
  organizationId?: string | null;
  /** Scoped issuer flavor for hosted forwards: "org" (/o/<orgId>, signed-in
   * members) or "anonymous" (/g/<personalOrgId>, the anonymous test issuer a
   * RAS must explicitly allowlist). Defaults to "org". */
  issuerKind?: "org" | "anonymous";
  /** Whether the issuer accepts the RFC 8693 grant at `/token`. Hosted
   * unscoped issuers use the JSON mint fallback. Defaults to true. */
  specTokenEndpointAvailable?: boolean;
  requestExecutor: XAARequestExecutor;
  scheduleAutoAdvance?: (next: () => void) => void;
  negativeTestMode?: NegativeTestMode;
  /** Input axis (see XAAFlowState.identityAssertionFormat). */
  identityAssertionFormat?: IdentityAssertionFormat;
  /** Output axis (see XAAFlowState.subjectIdentifierFormat). */
  subjectIdentifierFormat?: SubjectIdentifierFormat;
  userId?: string;
  email?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authzServerIssuer?: string;
  /** Hosted registration-backed runs: sent to the token proxy instead of an
   * inline client secret; the server resolves the stored secret and forces
   * the outbound URL to the registration's stored token endpoint. */
  registrationId?: string;
  /** Server-target confidential runs: sent to the token proxy instead of an
   * inline client secret or token endpoint. The server resolves the stored
   * secret AND discovers the token endpoint from the server's own config, so
   * neither the secret nor the destination rides in from the browser. */
  serverId?: string;
  projectId?: string;
  /** Client-identity strategy. Forced to "preregistered" whenever
   * registrationId or serverId is set (those paths skip AS discovery). */
  registrationStrategy?: RegistrationStrategy;
  /** Target-scoped in-memory session cache for DCR-minted credentials. The
   * UI passes a useRef-backed cache so machine recreation neither loses nor
   * re-exposes the secret; unit tests may pass a Map-backed one. */
  dcrCredentialCache?: XaaDcrCredentialCache;
  /** Stable key for the current target; combined with the discovered
   * registration endpoint to key the credential cache. */
  dcrCacheTargetKey?: string;
  /** CIMD: the Client ID Metadata Document URL to present as the client_id.
   * Defaults to the hosted XAA debugger document. Validated, never normalized. */
  clientIdMetadataUrl?: string;
}

export interface XAAStateMachine {
  state: XAAFlowState;
  updateState: (updates: Partial<XAAFlowState>) => void;
  proceedToNextStep: () => Promise<void>;
  /** Drive every remaining step until the flow completes or a step fails. */
  runAll: () => Promise<void>;
  resetFlow: () => void;
}

export const EMPTY_XAA_FLOW_STATE: XAAFlowState = {
  isBusy: false,
  currentStep: "idle",
  registrationStrategy: "preregistered",
  serverUrl: undefined,
  resourceUrl: undefined,
  resourceMetadataUrl: undefined,
  resourceMetadata: undefined,
  authzServerIssuer: undefined,
  authzMetadata: undefined,
  tokenEndpoint: undefined,
  negativeTestMode: DEFAULT_NEGATIVE_TEST_MODE,
  identityAssertionFormat: DEFAULT_IDENTITY_ASSERTION_FORMAT,
  subjectIdentifierFormat: DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  identityAssertionSubject: undefined,
  userId: undefined,
  email: undefined,
  clientId: undefined,
  clientSecret: undefined,
  scope: undefined,
  identityAssertion: undefined,
  idJag: undefined,
  idJagDecoded: undefined,
  accessToken: undefined,
  tokenType: undefined,
  expiresIn: undefined,
  lastRequest: undefined,
  lastResponse: undefined,
  httpHistory: [],
  infoLogs: [],
  error: undefined,
  negativeProbe: undefined,
  compatibilityReport: undefined,
};

export function createInitialXAAFlowState(
  overrides: Partial<XAAFlowState> = {}
): XAAFlowState {
  return {
    ...EMPTY_XAA_FLOW_STATE,
    ...overrides,
    negativeTestMode: overrides.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE,
    identityAssertionFormat:
      overrides.identityAssertionFormat ?? DEFAULT_IDENTITY_ASSERTION_FORMAT,
    subjectIdentifierFormat:
      overrides.subjectIdentifierFormat ?? DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
    httpHistory: overrides.httpHistory ?? [],
    infoLogs: overrides.infoLogs ?? [],
  };
}
