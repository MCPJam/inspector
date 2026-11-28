/**
 * Server feature model (KES-886).
 *
 * One catalog of MCP features and one evaluator that turns four evidence
 * sources into a single user-facing state per feature:
 *
 *   declared  — saved at connect (serverInfo, capabilities, list results)
 *   probed    — read-only background probes after connect
 *   observed  — feature ids seen in normal traffic (never payloads)
 *   checked   — results of conformance runs the user started
 *
 * plus `oauth-flow`, a non-secret summary written when the connect OAuth flow
 * completes. A feature whose primary source is `configured` needs setup in
 * MCPJam first (a pre-registered OAuth client, say); the setup is a
 * precondition, never evidence that the server supports the feature.
 *
 * Browser-safe and pure: no I/O and no Node imports anywhere in this folder.
 */

import type {
  DirectoryEvidenceProvenance,
  DirectoryIntrusiveness,
} from "../directory-readiness/types.js";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

/** Cards follow the MCP specification's own sections (product spec v0.4). */
export const FEATURE_CARD_IDS = [
  "server-info",
  "base-protocol",
  "server-features",
  "server-utilities",
  "client-features",
  "authorization",
  "extensions",
  "third-party",
] as const;
export type FeatureCardId = (typeof FEATURE_CARD_IDS)[number];

/**
 * The 24 families from audit 2, in display order. The number in each comment
 * is the family's row in the audit's inventory table.
 */
export const FEATURE_FAMILY_IDS = [
  "server-information", // 1
  "lifecycle-discovery", // 2
  "transports", // 3
  "transport-behavior", // 4
  "mrtr", // 15
  "subscriptions", // 16
  "tools-discovery", // 5
  "tool-annotations-schemas", // 6
  "tool-results", // 7
  "resources", // 8
  "resource-templates", // 9
  "prompts", // 10
  "completion", // 11
  "pagination-caching", // 12
  "request-control", // 13
  "client-features", // 14
  "core-authorization", // 17
  "authorization-extensions", // 18
  "mcp-apps", // 19
  "tasks", // 20
  "skills", // 21
  "events", // 22
  "server-cards", // 23
  "third-party-experimental", // 24
] as const;
export type FeatureFamilyId = (typeof FEATURE_FAMILY_IDS)[number];

export interface FeatureFamilyDefinition {
  id: FeatureFamilyId;
  card: FeatureCardId;
  /** Official name, in the specification's own words where it has one. */
  name: string;
  /** One sentence: what this family covers. */
  summary: string;
}

/** Who provides the feature on the wire. Only server-side owners can be gaps. */
export type FeatureOwner =
  | "server"
  | "client"
  | "host"
  | "app"
  | "authorization-server"
  | "identity-provider";

/** Maturity of the document that defines the feature. */
export type FeatureStage =
  | "stable"
  | "beta"
  | "experimental"
  | "sketch"
  | "early-access";

/** Where the feature is defined; used for the pinned spec link. */
export type FeatureSpecSource =
  | "core"
  | "ext-apps"
  | "ext-tasks"
  | "ext-skills"
  | "ext-events"
  | "ext-auth"
  | "ext-server-card"
  | "openai-mcp-extensions"
  | "openai-apps-sdk"
  | "experimental";

export interface FeatureSpecRef {
  url: string;
  source: FeatureSpecSource;
  /** Commit or tag the summary and lifecycle were checked against. */
  pin: string;
  /** ISO date (YYYY-MM-DD) the pin was last checked. */
  checkedAt: string;
}

/**
 * Lifecycle per core protocol revision (wire literals such as
 * "2025-06-18"). Absent `introduced` means the feature exists in every known
 * revision. An extension feature that is independent of the core revision
 * leaves all three unset.
 */
export interface FeatureLifecycle {
  introduced?: string;
  deprecated?: string;
  removed?: string;
}

/** Features the user sets up in MCPJam before they can be assessed. */
export type FeatureSetupKind =
  | "client-credentials"
  | "enterprise-managed-authorization"
  | "event-webhook"
  | "pre-registered-client"
  | "openai-onboarding";

/** Conformance suites whose check ids map onto features. */
export type ConformanceSuiteKey =
  | "protocol"
  | "apps"
  | "tasks"
  | "events"
  | "oauth";

/** `${suite}:${checkId}`, e.g. "protocol:tools-list". */
export type ConformanceCheckRef = `${ConformanceSuiteKey}:${string}`;

/**
 * What a source can say about one feature.
 *
 * `absent` must name the coverage it relies on: the evaluator turns it into
 * "Could add" only when every key in `basis` was captured completely, so a
 * dropped field or a partial list never reads as a gap.
 */
export type FeatureRuleOutcome =
  | {
      kind: "present";
      /** advertised = a capability or field declares it; detected = a
       * descriptor or metadata field shows it without a declaration. */
      via: "advertised" | "detected" | "probed" | "oauth-flow";
      detail?: string;
      count?: number;
    }
  | { kind: "absent"; basis: readonly CoverageKey[]; detail?: string }
  | { kind: "unknown"; reason: string }
  | { kind: "not-applicable"; reason: string }
  | null;

export interface FeatureAssessmentRules {
  /** The cheapest reliable source; drives the "Not checked yet" next step. */
  primary: Exclude<EvidenceSource, "detected">;
  declared?: (surface: DeclaredSurface) => FeatureRuleOutcome;
  probed?: (probes: ProbeSurface) => FeatureRuleOutcome;
  oauthFlow?: (summary: OAuthFlowSummary) => FeatureRuleOutcome;
  /** True when the observation classifier can emit this feature's id. */
  observable?: boolean;
  /**
   * Set when the classifier emits this id only on connections of one era,
   * so the Playground is no step on the other.
   */
  observableEra?: "legacy" | "modern";
  /** Set up in MCPJam before it can be assessed. */
  setup?: FeatureSetupKind;
  /**
   * Client extension a server may require before it shows this feature,
   * e.g. "io.modelcontextprotocol/ui" for MCP Apps (servers can hide UI tools
   * from clients without it). When the capture context did not advertise it,
   * an `absent` outcome means "depends on the client", never "Could add".
   */
  requiresClientExtension?: string;
}

export interface FeatureDefinition {
  /** Stable, unique, kebab/dot id, e.g. "tools.annotations.read-only-hint". */
  id: string;
  family: FeatureFamilyId;
  /** Parent feature id in the same family, for tree rows. */
  parent?: string;
  /** Official name. */
  name: string;
  /** What it enables, one sentence. */
  summary: string;
  /** How to add it (server owners) or how to test it (everyone else). */
  howTo: string;
  owner: FeatureOwner;
  spec: FeatureSpecRef;
  stage: FeatureStage;
  lifecycle: FeatureLifecycle;
  /**
   * True when leaving the feature out is a legitimate server choice. Only
   * optional, server-owned, applicable features can become "Could add".
   */
  optional: boolean;
  /** Check results reach a feature through `check-map/`, never from here. */
  assessment: FeatureAssessmentRules;
}

// ---------------------------------------------------------------------------
// Evidence inputs
// ---------------------------------------------------------------------------

export type EvidenceSource =
  | "declared"
  | "detected"
  | "probed"
  | "observed"
  | "checked"
  | "oauth-flow"
  | "configured";

/** How completely a part of the declared surface was captured. */
export type CoverageState = "complete" | "partial" | "not-captured";

export const COVERAGE_KEYS = [
  "serverInfo",
  "capabilities",
  "instructions",
  "tools",
  "toolMeta",
  "toolSchemas",
  "resources",
  "resourceTemplates",
  "prompts",
  "skills",
  "listHints",
] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

export type DeclaredItem = Readonly<Record<string, unknown>>;

export interface ListCacheHints {
  ttlMs?: number;
  cacheScope?: string;
  pages?: number;
}

/**
 * Everything the server declared at connect, normalized from any stored
 * snapshot version by `toDeclaredSurface`. Descriptors keep their MCP field
 * names (`_meta`, `inputSchema`, …) so catalog rules read the wire shape.
 */
export interface DeclaredSurface {
  /** Snapshot envelope version this surface came from. */
  envelopeVersion: number;
  protocolVersion?: string;
  supportedVersions?: readonly string[];
  serverInfo?: DeclaredItem;
  instructions?: string;
  /** Raw capabilities, unknown keys included when the producer kept them. */
  capabilities?: DeclaredItem;
  discoveryMeta?: DeclaredItem;
  tools: readonly DeclaredItem[];
  resources: readonly DeclaredItem[];
  resourceTemplates: readonly DeclaredItem[];
  prompts: readonly DeclaredItem[];
  skills: readonly DeclaredItem[];
  listHints: Readonly<
    Partial<
      Record<
        "tools" | "resources" | "resourceTemplates" | "prompts",
        ListCacheHints
      >
    >
  >;
  coverage: Readonly<Record<CoverageKey, CoverageState>>;
  transport: CaptureTransport;
}

/** Read-only probes the background runner may run (engineering spec §2). */
export const SERVER_PROBE_IDS = [
  "http-transport",
  "authorization",
  "server-card",
  "apps-ui-resources",
  "skills",
  "events-list",
] as const;
export type ServerProbeId = (typeof SERVER_PROBE_IDS)[number];

export type ProbeScalar = string | number | boolean | null;
export type ProbeValue = ProbeScalar | readonly ProbeScalar[];

export type ProbeStatus =
  | "ok"
  | "failed"
  | "skipped"
  | "not-applicable"
  | "abandoned";

/** Check status as conformance reports it, narrowed to what we store. */
export type CheckStatus = "passed" | "failed" | "skipped" | "warned";

/**
 * One bounded probe summary. `values` keys are fixed per probe by
 * `ProbeValueKeys`; strings are short identifiers or URLs, never free text
 * from the server beyond a bounded `detail`.
 */
export interface ProbeSummary<P extends ServerProbeId = ServerProbeId> {
  probeId: P;
  status: ProbeStatus;
  coverage: CoverageState;
  at: number;
  /** Bounded, non-secret explanation of a failure or skip. */
  detail?: string;
  values: Partial<Record<ProbeValueKeys[P], ProbeValue>>;
  /** Read-only conformance checks graded by the probe, by check ref. */
  checks?: Readonly<Partial<Record<ConformanceCheckRef, CheckStatus>>>;
}

/**
 * The value keys each probe writes. The probe runner (producer) and the
 * catalog rules (consumer) both type against this map.
 */
export interface ProbeValueKeysMap {
  "http-transport":
    | "status" // "ready" | "oauth_required" | "reachable" | "error"
    | "selectedTransport" // "streamable-http" | "sse" | null
    | "streamableHttp" // boolean
    | "legacySse" // boolean
    | "responseContentType" // "application/json" | "text/event-stream" | null
    | "sessionIdIssued" // boolean
    | "protocolVersion"; // string | null
  authorization:
    | "oauthRequired" // boolean
    | "oauthOptional" // boolean
    | "challengeHasResourceMetadata" // boolean
    | "nonCompliantChallengeStatus" // number | null
    | "prmFound" // boolean
    | "prmResource" // string | null
    | "prmAuthorizationServers" // string[]
    | "prmScopesSupported" // string[]
    | "asMetadataFound" // boolean
    | "asMetadataKind" // "oauth" | "oidc" | null
    | "issuer" // string | null
    | "grantTypesSupported" // string[]
    | "tokenEndpointAuthMethods" // string[]
    | "codeChallengeMethods" // string[]
    | "responseTypesSupported" // string[]
    | "registrationEndpoint" // boolean (DCR)
    | "cimdSupported" // boolean
    | "registrationStrategies" // string[] of "preregistered" | "dcr" | "cimd"
    | "authorizationGrantProfiles"; // string[] (XAA ID-JAG profiles)
  "server-card":
    | "aiCatalogFound" // boolean
    | "catalogEntryFound" // boolean
    | "serverCardFound" // boolean
    | "serverCardUrl" // string | null
    | "mediaTypeOk" // boolean
    | "requiredFieldsOk" // boolean
    | "missingFields" // string[]
    | "optionalFields" // string[] present
    | "remotesListed" // boolean
    | "hasMeta" // boolean
    | "consistentWithRuntime" // boolean | null
    | "corsAllowed" // boolean | null
    | "cacheControl" // boolean
    | "https"; // boolean
  "apps-ui-resources":
    | "uiResourceCount" // number
    | "readCount" // number
    | "readFailures" // number
    | "abandonedInputRequired" // number
    | "htmlProfileOk" // boolean
    | "cspDeclared" // boolean
    | "permissionsDeclared" // boolean
    | "domainDeclared" // boolean
    | "prefersBorderDeclared"; // boolean
  skills:
    | "listed" // boolean
    | "count" // number
    | "verified" // number
    | "digestFailures" // number
    | "frontmatterFailures" // number
    | "directoryRead"; // boolean
  "events-list":
    | "listed" // boolean
    | "eventCount" // number
    | "deliveryModes"; // string[]
}
export type ProbeValueKeys = {
  [P in ServerProbeId]: ProbeValueKeysMap[P];
};

/** Latest summary per probe for one capture context. */
export type ProbeSurface = Readonly<
  Partial<{ [P in ServerProbeId]: ProbeSummary<P> }>
>;

/**
 * Non-secret summary of a completed connect OAuth flow (engineering spec
 * §1b). Never tokens, secrets, PKCE verifiers, state or codes.
 */
export interface OAuthFlowSummary {
  completedAt: number;
  issuer?: string;
  protocolVersion?: string;
  registrationStrategy?: "preregistered" | "dcr" | "cimd";
  resourceIndicatorSent: boolean;
  scopesRequested: readonly string[];
  scopesGranted: readonly string[];
  issReturned: boolean;
  issValidated: boolean;
  refreshTokenIssued: boolean;
  tokenEndpointAuthMethod?: string;
}

/** Payload-free "seen in use" record. */
export interface FeatureObservation {
  featureId: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSource: ObservationSource;
}
export type ObservationSource = "rpc" | "apps-bridge";

/** One conformance check result from the latest run for this server. */
export interface CheckResultEvidence {
  ref: ConformanceCheckRef;
  status: CheckStatus;
  runId: string;
  runAt: number;
  /** Protocol version the run negotiated; results apply only to it. */
  protocolVersion?: string;
}

// ---------------------------------------------------------------------------
// Capture context
// ---------------------------------------------------------------------------

export type CaptureTransport = "stdio" | "streamable-http" | "sse" | "unknown";

/**
 * The context evidence was captured under. Evidence from different contexts
 * is never merged. No credentials: `accountBinding` is an opaque key.
 */
export interface CaptureContext {
  protocolVersion?: string;
  era?: "legacy" | "modern" | "unknown";
  transport: CaptureTransport;
  /** Hash of the client capabilities MCPJam advertised. */
  clientCapabilitiesHash?: string;
  /** Extension ids the client advertised, e.g. "io.modelcontextprotocol/ui". */
  clientExtensions?: readonly string[];
  hostProfile?: string;
  environmentId?: string;
  /** Opaque connection or auth-context key; never a credential. */
  accountBinding?: string;
  configRevision?: string;
}

// ---------------------------------------------------------------------------
// Evaluation output
// ---------------------------------------------------------------------------

/** The five user-facing states, plus not-applicable (e.g. stdio auth). */
export const FEATURE_USER_STATES = [
  "check-failed",
  "supported",
  "needs-newer",
  "could-add",
  "not-checked",
  "not-applicable",
] as const;
export type FeatureUserState = (typeof FEATURE_USER_STATES)[number];

export type FeatureMarker =
  | "deprecated"
  | "removed"
  | "beta"
  | "experimental"
  | "sketch"
  | "early-access";

export type FeatureApplicability =
  | "applies"
  | "not-yet" // introduced after the negotiated version
  | "removed" // removed at or before the negotiated version
  | "unknown-version" // version unknown or newer than the catalog knows
  | "not-applicable"; // e.g. HTTP-only feature on stdio

export type FeatureNextAction =
  | "connect"
  | "reconnect"
  | "run-checks"
  | "use-in-playground"
  | "set-up"
  | "refresh"
  | "upgrade-version";

/**
 * One piece of evidence about one feature. Generalizes
 * `DirectoryCapabilityBadge` / `DirectoryReadinessFinding` with the source,
 * context and coverage the canvas needs.
 */
export interface FeatureEvidence {
  featureId: string;
  source: EvidenceSource;
  outcome: "present" | "absent" | "failed" | "unknown" | "not-applicable";
  provenance: DirectoryEvidenceProvenance;
  intrusiveness: DirectoryIntrusiveness;
  coverage: CoverageState;
  contextHash?: string;
  capturedAt?: number;
  detail?: string;
  count?: number;
  ref?: { runId?: string; check?: ConformanceCheckRef; probeId?: ServerProbeId };
}

export interface FeatureAssessment {
  featureId: string;
  state: FeatureUserState;
  /** Sources that support the state, strongest first. */
  sources: readonly EvidenceSource[];
  markers: readonly FeatureMarker[];
  applicability: FeatureApplicability;
  /** Why the row is in this state, one sentence. */
  reason?: string;
  nextAction?: FeatureNextAction;
  evidence: readonly FeatureEvidence[];
  /** Newest evidence time behind the state. */
  seenAt?: number;
}

export type FeatureStateCounts = Readonly<Record<FeatureUserState, number>>;

export interface FeatureGroupSummary<Id extends string> {
  id: Id;
  counts: FeatureStateCounts;
  /** Leaf features in this group, parents excluded. */
  leafCount: number;
}

export interface ServerFeatureEvaluation {
  context?: CaptureContext;
  contextHash?: string;
  /** Keyed by feature id; covers every catalog entry, parents included. */
  assessments: Readonly<Record<string, FeatureAssessment>>;
  cards: readonly FeatureGroupSummary<FeatureCardId>[];
  families: readonly FeatureGroupSummary<FeatureFamilyId>[];
  totals: FeatureStateCounts;
}

/** Everything the evaluator reads, already filtered to one context. */
export interface ServerFeatureEvidenceInput {
  context?: CaptureContext;
  /**
   * Never connected: features read "Not checked yet". Most offer Connect; one
   * that needs setup offers Set up first, or no step when this surface cannot
   * offer that setup.
   */
  connected: boolean;
  declared?: { surface: DeclaredSurface; capturedAt: number };
  probes?: ProbeSurface;
  oauthFlow?: OAuthFlowSummary;
  observations?: readonly FeatureObservation[];
  checks?: readonly CheckResultEvidence[];
  /** Setup the user has done in MCPJam for this server. */
  configured?: readonly FeatureSetupKind[];
  /**
   * Setup this MCPJam surface can offer. A feature needing any other kind
   * says MCPJam cannot check it yet, instead of offering a Set up step.
   */
  setupOffered?: readonly FeatureSetupKind[];
  /**
   * Conformance suites this MCPJam surface can run. Absent means any suite;
   * a feature whose checks are all in other suites gets no Run checks step.
   */
  checksOffered?: readonly ConformanceSuiteKey[];
}
