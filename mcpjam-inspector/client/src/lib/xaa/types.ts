import type { RemoteXaaPerson } from "@/hooks/useXaaPeople";

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
  createInitialXAAFlowState,
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

// ---------------------------------------------------------------------------
// Managed test IdP (setup center). Org-scoped synthetic People, per-app
// connections for the fixed MCPJam Agent, and per-person scope assignments.
// Hand-mirrored from the backend `xaaTestIdentities` /
// `xaaManagedConnections` serializers (two-repo layout). Client-owned.
// ---------------------------------------------------------------------------

/** Archived identities never reach the wire — `list` filters them out. */
export type XaaOrgPersonStatus = "active" | "suspended";

/**
 * Org-scoped synthetic person: the project fixture shape plus a status the
 * policy evaluator enforces at mint time (suspend blocks new ID-JAGs).
 */
export type RemoteOrgXaaPerson = RemoteXaaPerson & {
  status: XaaOrgPersonStatus;
};

/** `selected` requires an explicit scope subset; empty selected = deny-all. */
export type XaaScopeMode = "all" | "selected";

export interface XaaManagedAssignment {
  _id: string;
  connectionId: string;
  testIdentityId: string;
  scopeMode: XaaScopeMode;
  /** Present iff scopeMode === "selected"; ⊆ connection-effective scopes. */
  selectedScopes?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Connection row joined with its assignments (listWithAssignments shape). */
export interface XaaManagedConnection {
  _id: string;
  resourceAppId: string;
  enabled: boolean;
  scopeMode: XaaScopeMode;
  /** Present iff scopeMode === "selected"; ⊆ the app's scopes. */
  selectedScopes?: string[];
  assignments: XaaManagedAssignment[];
  createdAt: number;
  updatedAt: number;
}

/** Result of copying a project's fixtures into the org roster. */
export interface XaaImportFromProjectResult {
  imported: number;
  skippedExisting: number;
  skippedOverCap: number;
}

/**
 * The scopes a connection lets through, given its parent app's scope catalog.
 * `all` mirrors the parent; `selected` uses the explicit subset (an absent
 * subset is deny-all, never silently "all").
 */
export function effectiveXaaScopes(
  scopeMode: XaaScopeMode,
  selectedScopes: string[] | undefined,
  parentScopes: string[],
): string[] {
  return scopeMode === "all" ? parentScopes : (selectedScopes ?? []);
}
