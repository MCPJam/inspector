// XAA flow-core types moved to @mcpjam/sdk (browser-safe). Re-exported here so
// existing `@/lib/xaa/types` importers keep their path. The hosted test-bench
// resource-app types stay client-owned (below) — they are inspector wire types,
// not engine types.
export type {
  XAAFlowStep,
  RegistrationStrategy,
  XaaTokenEndpointAuthMethod,
  XaaRegistrationWarningCode,
  XaaRegistrationWarning,
  XaaEphemeralDcrCredentials,
  XaaDcrCredentialCache,
  XAAJWTInspectionIssue,
  XAADecodedJwt,
  XAAInfoLogEntry,
  XAAHttpHistoryEntry,
  XAAFlowState,
  XAARequestResult,
  XAARequestExecutor,
  BaseXAAStateMachineConfig,
  XAAStateMachine,
  XAACompatibilityReport,
} from "@mcpjam/sdk/browser";
export {
  EMPTY_XAA_FLOW_STATE,
  buildXaaDcrCredentialCacheKey,
  createInitialXAAFlowState,
  isXaaDcrClientSecretExpired,
} from "@mcpjam/sdk/browser";

// ---------------------------------------------------------------------------
// Registered resource apps (hosted test bench). The wire shape mirrors the
// backend's sanitized projection: the client secret is never returned, only a
// `hasSecret` boolean. Client-owned — not part of the shared engine.
// ---------------------------------------------------------------------------

export type XaaResourceType = "rest" | "mcp";
export type XaaAuthServerMode = "mcpjam" | "own";

export interface XaaResourceApp {
  id: string;
  name: string;
  resourceType: XaaResourceType;
  resourceUrl: string;
  authServerMode: XaaAuthServerMode;
  tokenEndpoint?: string;
  issuer?: string;
  targetClientId?: string;
  scopes?: string[];
  healthCheckUrl?: string;
  hasSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Args accepted by the upsert action. `id` present = update. */
export interface XaaResourceAppInput {
  id?: string;
  name: string;
  resourceType: XaaResourceType;
  resourceUrl: string;
  authServerMode: XaaAuthServerMode;
  tokenEndpoint?: string;
  issuer?: string;
  targetClientId?: string;
  /** Plaintext secret; sent only when set/changed, never returned. */
  secret?: string;
  scopes?: string[];
  healthCheckUrl?: string;
}
