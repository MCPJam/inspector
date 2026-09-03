/**
 * Browser-safe SDK entrypoint.
 *
 * This subpath must stay free of Node-only runtime imports.
 */

export {
  applyRuntimeClientCapabilities,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
} from "./mcp-client-manager/capabilities.js";
export {
  MCP_DIRECT_IMAGE_MAX_BYTES,
  MCP_IMAGE_MAX_MEDIA_PARTS,
  MCP_IMAGE_MAX_TOTAL_BYTES,
  MCP_LINKED_RESOURCE_MAX_READS,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
  type McpModelOutputOptions,
  type McpModelOutputWithLinkedResourcesOptions,
  type McpModelVisibleToolResultPolicy,
  type McpLinkedResourceReader,
} from "./mcp-client-manager/model-output.js";
/**
 * Model-backed observations — the RENDERING and STATUS surface only.
 *
 * A browser needs to render an observation, badge its confidence, and branch
 * on `billing_limit_reached` to offer a top-up. It has no business VALIDATING
 * provider output or MAPPING an envelope into findings: both happen where the
 * run is graded, and a second implementation in the client would eventually
 * disagree with the first about what a model was allowed to say.
 *
 * So the constants, the reason union and the result types cross; the parser
 * and the mappers do not.
 */
export {
  DIRECTORY_OBSERVATION_CONFIDENCE,
  DIRECTORY_OBSERVATION_FINDING_CLASSES,
  DIRECTORY_OBSERVATION_LIMITS,
  DIRECTORY_OBSERVATION_REASONS,
  DIRECTORY_OBSERVATION_STATUSES,
  NOT_REQUESTED_OBSERVATIONS,
} from "./directory-readiness/observations.js";
export type {
  DirectoryObservation,
  DirectoryObservationConfidence,
  DirectoryObservationEnvelope,
  DirectoryObservationFindingClass,
  DirectoryObservationReason,
  DirectoryObservationState,
  DirectoryObservationStatus,
} from "./directory-readiness/observations.js";

/**
 * The reuse guard's VOCABULARY, so a client can explain a refused adaptation
 * ("that apps result graded a different server") without holding the adapters
 * themselves — those read raw tool `_meta` a browser has no business seeing.
 */
export {
  EVIDENCE_REUSE_REFUSALS,
  sameReadinessTarget,
} from "./directory-readiness/evidence-reuse.js";
export type {
  AttributableEvidenceSource,
  EvidenceReuse,
  EvidenceReuseExpectation,
  EvidenceReuseRefusal,
} from "./directory-readiness/evidence-reuse.js";

export {
  CLAUDE_OBSERVATION_IDS,
  CLAUDE_OBSERVATION_KINDS,
  CLAUDE_OBSERVATION_SCHEMA_VERSION,
} from "./claude-readiness/observations.js";
export type {
  ClaudeExperienceObservations,
  ClaudeObservationId,
  ClaudeObservationKind,
  ClaudeObservationState,
} from "./claude-readiness/observations.js";

export {
  OPENAI_OBSERVATION_IDS,
  OPENAI_OBSERVATION_KINDS,
  OPENAI_OBSERVATION_SCHEMA_VERSION,
} from "./openai-readiness/observations.js";
export type {
  OpenAIExperienceObservations,
  OpenAIObservationId,
  OpenAIObservationKind,
  OpenAIObservationState,
} from "./openai-readiness/observations.js";

/**
 * Claude directory readiness — the RENDERING surface only.
 *
 * Named rather than `export *`, and narrower than the readiness barrel, for
 * two reasons. A wildcard would make any symbol added to
 * `claude-readiness/index.ts` public browser API with no change to this file
 * and no reviewer looking at it. And a client renders lanes, coverage and
 * badges; it does not RUN checks, so the check runners and their evidence
 * types have no business in a browser bundle even though they are pure enough
 * to survive one.
 */
export {
  CLAUDE_EVIDENCE_PROVENANCE,
  CLAUDE_FINDING_CLASSES,
  CLAUDE_INTRUSIVENESS_LEVELS,
  CLAUDE_READINESS_ENGINE_VERSION,
  CLAUDE_READINESS_LANES,
  CLAUDE_REQUIRED_LANES,
  CLAUDE_RUNNER_CAPABILITIES,
  decideLaneStatus,
  isDispositiveClaudeFinding,
  rollUpLaneStatus,
  summarizeLaneCoverage,
} from "./claude-readiness/types.js";
export type {
  ClaudeCapabilityBadge,
  ClaudeEvidenceProvenance,
  ClaudeFindingClass,
  ClaudeFindingStatus,
  ClaudeIntrusiveness,
  ClaudeLaneCoverage,
  ClaudeLaneStatus,
  ClaudeReadinessAuthMode,
  ClaudeReadinessFinding,
  ClaudeReadinessLane,
  ClaudeReadinessLaneResult,
  ClaudeReadinessResult,
  ClaudeReadinessRunContext,
  ClaudeRunnerCapability,
} from "./claude-readiness/types.js";

// The policy corpus, so a surface can say WHICH revision a grade was made
// against — and whether the corpus was ever snapshotted at all.
export {
  CLAUDE_DOCS_BASE_URL,
  CLAUDE_POLICY_MANIFEST,
  CLAUDE_POLICY_PAGES,
  CLAUDE_POLICY_SNAPSHOT_DATE,
  claudePolicySource,
  isPolicyCorpusVerified,
} from "./claude-readiness/manifest.js";
export type {
  ClaudePolicyPage,
  ClaudePolicySourceEntry,
  ClaudePolicySourceRef,
} from "./claude-readiness/manifest.js";

// Claude's own constants, and the submission form's shape — a client
// validating that form before it is submitted needs both.
export {
  CLAUDE_APP_CONTENT_DOMAIN_SUFFIX,
  CLAUDE_APP_DESIGN_BUDGETS,
  CLAUDE_APP_HTML_MIME,
  CLAUDE_CALLBACK_URLS,
  CLAUDE_HOST_PROFILE,
  CLAUDE_LATENCY_BUDGETS,
  CLAUDE_SUBMISSION_LIMITS,
} from "./claude-readiness/profile.js";
export {
  CLAUDE_ATTESTATIONS,
  CLAUDE_DATA_HANDLING_MODES,
  CLAUDE_DECLARED_AUTH_MODES,
  claudeSubmissionProfileSchema,
  parseClaudeSubmissionProfile,
} from "./claude-readiness/submission-profile.js";
export type {
  ClaudeAttestation,
  ClaudeDataHandlingMode,
  ClaudeDeclaredAuthMode,
  ClaudeSubmissionProfile,
  ClaudeSubmissionProfileParse,
} from "./claude-readiness/submission-profile.js";

/**
 * OpenAI plugin-directory readiness — the RENDERING surface only.
 *
 * Named rather than `export *`, and narrower than the readiness barrel, for the
 * same two reasons as the Claude block above. A wildcard would make any symbol
 * added to `openai-readiness/index.ts` public browser API with no change to
 * this file and no reviewer looking at it. And a client renders lanes, stages
 * and coverage; it does not RUN checks, so the check runners and the evidence
 * gatherer have no business in a browser bundle.
 *
 * The package PRIMITIVES are the exception, and deliberately so: the inspector
 * validates a dropped package in the page, before anything is uploaded, and
 * every one of them is pure computation over bytes.
 */
export {
  OPENAI_HEADLINE_STAGE,
  OPENAI_READINESS_ENGINE_VERSION,
  OPENAI_READINESS_INPUTS,
  OPENAI_READINESS_LANES,
  OPENAI_READINESS_STAGES,
  OPENAI_RUNNER_CAPABILITIES,
  OPENAI_STAGE_LANES,
  OPENAI_SUBMISSION_MODES,
  OPENAI_SUBMISSION_MODE_SHAPES,
  isLaneApplicableInMode,
  isOpenAIReadinessResult,
  stageLanesFor,
} from "./openai-readiness/types.js";
export type {
  OpenAICapabilityBadge,
  OpenAILaneCoverage,
  OpenAILaneStatus,
  OpenAIReadinessFinding,
  OpenAIReadinessLane,
  OpenAIReadinessLaneResult,
  OpenAIReadinessResult,
  OpenAIReadinessRunContext,
  OpenAIReadinessStage,
  OpenAIReadinessStageResult,
  OpenAIRunnerCapability,
  OpenAISubmissionMode,
} from "./openai-readiness/types.js";

export {
  OPENAI_POLICY_MANIFEST,
  OPENAI_POLICY_PAGES,
  OPENAI_POLICY_SNAPSHOT_DATE,
  isOpenAIPolicyCorpusVerified,
  openaiPolicySource,
} from "./openai-readiness/manifest.js";
export type {
  OpenAIPolicyPage,
  OpenAIPolicySourceEntry,
  OpenAIPolicySourceRef,
} from "./openai-readiness/manifest.js";

export {
  OPENAI_ARCHIVE_LIMITS,
  OPENAI_BRAND_COLOR_CONTRAST,
  OPENAI_FIELD_LIMITS,
  OPENAI_HOST_PROFILE,
  OPENAI_IMAGE_CONSTRAINTS,
  OPENAI_LISTING_CATEGORIES,
  OPENAI_MCP_SKILL_LIMITS,
} from "./openai-readiness/profile.js";
export type { OpenAIListingCategory } from "./openai-readiness/profile.js";

export {
  OPENAI_PORTAL_ERRORS,
  OPENAI_PORTAL_ERRORS_BY_ID,
  OPENAI_PORTAL_ERROR_CATEGORIES,
  groupPortalIssues,
  hasBlockingPortalIssue,
} from "./openai-readiness/portal-errors.js";
export type {
  OpenAIPortalErrorCategory,
  OpenAIPortalErrorDefinition,
  OpenAIPortalIssue,
} from "./openai-readiness/portal-errors.js";

export {
  OPENAI_ATTESTATIONS,
  OPENAI_DATA_TYPES,
  openaiSubmissionProfileSchema,
  parseOpenAISubmissionProfile,
  summarizeTestCases,
} from "./openai-readiness/submission-profile.js";
export type {
  OpenAIAttestation,
  OpenAIDataType,
  OpenAISubmissionProfile,
  OpenAISubmissionProfileParse,
} from "./openai-readiness/submission-profile.js";

export {
  checkBrandColor,
  parseHexColor,
} from "./openai-readiness/package/color.js";
export type { BrandColorCheck } from "./openai-readiness/package/color.js";
export {
  readImageDimensions,
  sniffImageMimeType,
} from "./openai-readiness/package/image-dimensions.js";
export type {
  ImageDimensions,
  ImageDimensionsResult,
} from "./openai-readiness/package/image-dimensions.js";
export {
  findUnsupportedCharacters,
  hasSurroundingWhitespace,
  isSupportedText,
} from "./openai-readiness/package/supported-text.js";
export type { UnsupportedCharacter } from "./openai-readiness/package/supported-text.js";
export { parseOpenAIAgentMetadata } from "./openai-readiness/package/openai-agent-metadata.js";
export type {
  OpenAIAgentMetadata,
  OpenAIAgentMetadataIssue,
  OpenAIAgentMetadataParse,
} from "./openai-readiness/package/openai-agent-metadata.js";
export { readOpenAIPluginPackage } from "./openai-readiness/package/reader.js";
export type {
  OpenAIArchiveObservations,
  OpenAIPluginPackageEvidence,
} from "./openai-readiness/package/reader.js";

export { redactForTelemetry } from "./telemetry-redaction.js";
/**
 * @deprecated Renamed to `redactForTelemetry`. Kept as an alias so external
 * consumers do not break on the rename; there is no plan to remove it soon.
 *
 * The rename exists because this is the SENTRY redactor: it over-redacts on
 * purpose, replacing whole values rather than preserving a correlatable
 * prefix. The OAuth *display* redactor is
 * `sanitizeOAuthTraceValue` in `oauth/state-machines/trace-redaction.ts`, and
 * the two must never be confused for each other — one being used where the
 * other belongs is how a credential either leaks or becomes unusable.
 */
export { redactForTelemetry as redactSensitiveValue } from "./telemetry-redaction.js";

// Error describer — pure, browser-safe. Same module exported from the
// root entrypoint; client code MUST import from this `/browser` subpath
// to avoid pulling Node-only deps via root `@mcpjam/sdk`.
export {
  describeError,
  describeAsSlug,
  isNormalizedError,
  originOf,
  ERROR_CATALOG,
  extractNodeErrno,
  RETRYABLE_NODE_ERROR_CODES,
} from "./error-describer/index.js";
export type {
  DescribeContext,
  ErrorOrigin,
  NormalizedError,
  ErrorCatalogEntry,
  ErrorCatalogSlug,
} from "./error-describer/index.js";

export type {
  BaseServerConfig,
  HttpServerConfig,
  StdioServerConfig,
  MCPServerConfig,
  MCPClientManagerConfig,
  MCPConnectionStatus,
  ServerSummary,
  ClientCapabilityOptions,
  ExecuteToolArguments,
  TaskOptions,
  ListToolsResult,
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
} from "./mcp-client-manager/types.js";
export type {
  ConnectedServerDoctorState,
  RunServerDoctorInput,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorDependencies,
  ServerDoctorError,
  ServerDoctorResult,
} from "./server-doctor.js";

export type {
  CompatibleProtocol,
  CustomProvider,
  LLMProvider,
} from "./types.js";

export {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  fetchToken,
  registerClient,
  selectResourceURL,
  startAuthorization,
  // The `refresh_token` grant, already used internally by `auth()`. Exported so
  // a caller doing a non-interactive refresh reuses it — same client-
  // authentication selection, same resource handling, and it already preserves
  // the caller's refresh token when the authorization server omits one — rather
  // than hand-rolling a provider and a second `fetchToken` call that have to
  // re-derive all of it.
  refreshAuthorization,
} from "./oauth/browser-auth.js";
export {
  canonicalizeResourceUrl,
  evaluateResourceIndicator,
  resolveResourceIndicatorValue,
} from "./oauth/resource-policy.js";
export type {
  ResourceIndicatorDecision,
  ResourceIndicatorSource,
  ResourceIndicatorStatus,
} from "./oauth/resource-policy.js";
export type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/client";

export {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  ID_JAG_GRANT_PROFILE,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  SAML2_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  MCPJAM_CLIENT_URI,
  MCPJAM_LOGO_URI,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_IDP_CLIENT_ID,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  evaluateIdJagClientMetadata,
  getBrowserDebugDynamicRegistrationMetadata,
  getXaaConnectClientMetadata,
  getXaaDebugClientMetadata,
} from "./oauth/client-identity.js";
export type {
  IdJagClientMetadataEvaluation,
  IdJagMetadataEvidence,
} from "./oauth/client-identity.js";
export {
  resolveAuthorizationPlan,
  resolveRegistrationStrategies,
} from "./oauth/authorization-plan.js";
export type {
  AuthorizationDiscoverySnapshot,
  AuthorizationPlanCapabilities,
  AuthorizationPlanInput,
  OAuthProtocolMode,
  OAuthRegistrationMode,
  OAuthRegistrationStrategy,
  ResolvedAuthorizationPlan,
} from "./oauth/authorization-plan.js";
export { buildOAuthSequenceActions } from "./oauth/sequence-actions.js";
export {
  createOAuthStateMachine,
  PROTOCOL_VERSION_INFO,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
  // Exported so a consumer can distinguish "MCPJam redacted its own live data"
  // from an authorization-server rejection; both otherwise end in a 401.
  assertOAuthResultCredentialsUnredacted,
  OAuthRedactedCredentialError,
} from "./oauth/state-machines/factory.js";
export type {
  ProbeHttpAttempt,
  ProbeInitializeInfo,
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
  ProbeOAuthDetails,
  ProbeTransportResult,
} from "./server-probe.js";
export { runOAuthStateMachine } from "./oauth/state-machines/runner.js";
// Exported so a consumer can recognize this specific step failure by identity
// instead of re-typing the message — it is the server under test violating
// RFC 8414, which a host may want to treat differently from its own errors.
export { AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER } from "./oauth/state-machines/shared/required-metadata.js";
// The debug proxy's own failures use a different error shape. This classifier
// lets browser hosts keep a target server's authenticated-request rejection in
// the debugger without sending it to their own exception tracker.
export { isAuthenticatedRequestFailure } from "./oauth/state-machines/shared/response-error.js";
// OAuth client emulation (HP-43): profile → generic machine knobs. Pure and
// client-name-free — per-client profiles live in the private backend.
export { deriveOAuthEmulation } from "./oauth/emulation/derive.js";
export type { DerivedOAuthEmulation } from "./oauth/emulation/derive.js";
export type {
  OAuthEmulationConfig,
  OAuthEmulationCoverage,
  OAuthEmulationDivergence,
  OAuthEmulationField,
  OAuthEmulationFieldStatus,
} from "./oauth/emulation/types.js";
export { OAUTH_EMULATION_FIELDS } from "./oauth/emulation/types.js";
export type {
  EmulatedAuthAttempt,
  EmulatedRegistrationPreference,
} from "./oauth/emulation/types.js";
// Pure redirect planning is browser-safe; the runner that uses it is not.
export {
  isInvalidRedirectUriRejection,
  planCompletionSafeRedirects,
} from "./oauth/emulation/redirects.js";
export type { CompletionSafeRedirectPlan } from "./oauth/emulation/redirects.js";
// SSRF host classification (shared hardening): the browser executor re-validates
// the FINAL response URL after redirects using the same RFC 6890 policy the
// factory guard applies to the initial request URL.
export {
  assertOutboundOAuthUrlAllowed,
  isPrivateHost,
  isDisallowedIpAddress,
  isLoopbackOAuthUrl,
  OAuthOutboundUrlBlockedError,
} from "./oauth/ssrf-guard.js";
// RFC 9207 authorization-response `iss` validation. The comparison itself is
// era-agnostic, but REJECTING on a mismatch is a 2026-07-28 (SEP-2468) rule —
// callers pass `enforcePresentIssMismatch` so pre-draft flows warn instead.
export {
  validateAuthorizationResponseIssuer,
  type AuthorizationResponseIssuerCheck,
} from "./oauth/state-machines/debug-oauth-2026-07-28.js";
// SEP-2350 runtime scope step-up core (2R-stepup): scope union, insufficient-
// scope challenge parsing, and the §10.5 interactive/M2M/debugger policy split.
// Era-agnostic — the step-up decision lives at the runtime request boundary.
export {
  computeScopeUnion,
  parseInsufficientScopeChallenge,
  resolveStepUpAction,
  type InsufficientScopeChallenge,
  type StepUpAuthMode,
  type StepUpAction,
} from "./oauth/state-machines/shared/challenges.js";
// The unauthenticated probe's acceptance gate. Exported so the debugger UI
// decides "is this exchange an expected challenge?" from the same rule the flow
// advances on, rather than re-testing `status === 401` and painting an accepted
// 403 as a failure.
export {
  classifyUnauthenticatedProbe,
  hasBearerChallenge,
  isUnauthenticatedProbeChallenge,
  UNAUTHENTICATED_PROBE_STEP,
  type UnauthenticatedProbeOutcome,
} from "./oauth/state-machines/shared/challenges.js";
export type {
  OAuthAuthorizationRequestResult,
  OAuthStateMachineRunConfig,
  OAuthStateMachineRunResult,
} from "./oauth/state-machines/runner.js";
export {
  createOAuthTraceProjectionContext,
  projectOAuthTraceSnapshot,
} from "./oauth/state-machines/trace.js";
export type {
  OAuthTraceProjectionContext,
  OAuthTraceSnapshot,
  OAuthTraceStepSnapshot,
  OAuthTraceStepStatus,
} from "./oauth/state-machines/trace.js";
// The single owner of OAuth trace redaction. The inspector re-exports these
// rather than keeping its own copy — the two sets had already drifted (`state`
// was sensitive on one side only), and drift here is a leak.
export {
  OAUTH_TRACE_SENSITIVE_FIELD_NAMES,
  describeOAuthStateMatch,
  isCredentialShapedAuthValue,
  isSensitiveHeaderName,
  isSensitiveQueryParamName,
  isSensitiveTraceFieldName,
  parseOAuthRequestFields,
  redactSensitiveTraceValue,
  sanitizeOAuthHeaders,
  sanitizeOAuthTraceValue,
  sanitizeOAuthUrl,
  sanitizeTraceErrorMessage,
} from "./oauth/state-machines/trace-redaction.js";
export type {
  OAuthRequestFields,
  OAuthStateMatchDiagnostics,
} from "./oauth/state-machines/trace-redaction.js";
export {
  getStepInfo,
  getStepIndex,
} from "./oauth/state-machines/shared/step-metadata.js";
export {
  buildDynamicClientRegistrationRequest,
  executeDynamicClientRegistration,
} from "./oauth/state-machines/shared/dynamic-client-registration.js";
export type {
  DynamicClientRegistrationCredentials,
  DynamicClientRegistrationOutcome,
} from "./oauth/state-machines/shared/dynamic-client-registration.js";
export {
  validateClientIdMetadataUrl,
  isLoopbackClientMetadataUrl,
  isLoopbackHost,
} from "./oauth/state-machines/shared/client-id-metadata.js";
export {
  decodeJWT,
  decodeJWTParts,
  formatJWTTimestamp,
} from "./oauth/state-machines/shared/jwt.js";
export type { DecodedJwtParts } from "./oauth/state-machines/shared/jwt.js";
// Pure XAA/ID-JAG primitives (single source of truth). Exported directly from
// constants.js — the ./xaa/index.js barrel is node-only (crypto/fs mint).
export {
  XAA_IDP_KID,
  NEGATIVE_TEST_MODES,
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  IDENTITY_ASSERTION_FORMATS,
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  normalizeIdentityAssertionFormat,
  SUBJECT_IDENTIFIER_FORMATS,
  DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  normalizeSubjectIdentifierFormat,
  XAA_CLIENT_AUTH_METHODS,
  DEFAULT_XAA_CLIENT_AUTH,
  normalizeXaaClientAuth,
} from "./xaa/constants.js";
export type {
  NegativeTestMode,
  IdentityAssertionFormat,
  SubjectIdentifierFormat,
  XaaClientAuthMethod,
} from "./xaa/constants.js";
// Shared client-registration vocabulary (single source of truth for OAuth
// flows AND the XAA debugger's Client↔Resource-AS leg).
export {
  REGISTRATION_STRATEGIES,
  DEFAULT_REGISTRATION_STRATEGY,
  DEFAULT_REGISTRATION_MODE,
  AUTH_METHODS,
  normalizeRegistrationStrategy,
  normalizeRegistrationMode,
  normalizeAuthMethod,
} from "./registration.js";
export type {
  RegistrationStrategy,
  RegistrationMode,
  AuthMethod,
} from "./registration.js";
export {
  NEGATIVE_TEST_MODE_DETAILS,
  isPolicyDependentNegativeTestMode,
} from "./xaa/negative-test-modes.js";
// Pure XAA discovery + MCP-initialize helpers (browser+node safe, no I/O).
export {
  canonicalizeMcpResource,
  buildProtectedResourceMetadataCandidates,
  buildAuthorizationServerMetadataCandidates,
  buildIssuerPublicationCandidates,
  XAA_AS_METADATA_NAMES,
} from "./xaa/discovery.js";
export {
  buildMcpInitializeRequest,
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
  MCP_INIT_ID,
  MCP_PROTOCOL_VERSION,
  XAA_MCP_EXTENSION,
} from "./xaa/mcp-init.js";
export type {
  McpInitializeRequest,
  XaaCapabilityEvidence,
} from "./xaa/mcp-init.js";
export {
  readXaaEnterprisePolicy,
  withXaaEnterprisePolicy,
  withoutXaaEnterprisePolicy,
  XAA_ENTERPRISE_POLICY_EXTENSION,
  XAA_ENTERPRISE_POLICY_IDPS,
} from "./xaa/enterprise-policy.js";
export type {
  XaaEnterprisePolicy,
  XaaEnterprisePolicyIdp,
  XaaEnterprisePolicyState,
} from "./xaa/enterprise-policy.js";
// XAA flow-core types + capability preflight (browser-safe engine primitives).
export * from "./xaa/state-machines/index.js";
export { EMPTY_OAUTH_FLOW_STATE } from "./oauth/state-machines/types.js";
export type {
  HttpHistoryEntry,
  InfoLogEntry,
  InfoLogLevel,
  LogErrorDetails,
  OAuthDynamicRegistrationMetadata,
  OAuthFlowState,
  OAuthFlowStep,
  OAuthProtocolVersion,
  OAuthRequestExecutor,
  OAuthRequestResult,
  OAuthStateMachine,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
  RegistrationStrategy2026_07_28,
} from "./oauth/state-machines/types.js";

// MCP conformance transport support — pure predicate, safe for the browser.
// UIs use this to decide which suites can run against a given server config.
export {
  canRunConformance,
  isHttpServerConfig,
} from "./mcp-conformance/transport-support.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
} from "./mcp-conformance/transport-support.js";

// Static check inventories. Every one of these modules reaches its non-leaf
// dependencies through `import type` only, so the runtime value exports here
// carry no Node-only code into the browser bundle. UIs use them to show what
// a suite WILL run before it has run — `CHECK_ERAS` + `PROTOCOL_VERSION_ERAS`
// narrow the protocol list to the era a pinned version actually exercises.
export {
  CHECK_ERAS,
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  PROTOCOL_VERSION_ERAS,
} from "./mcp-conformance/types.js";
export type { MCPCheckEra, MCPCheckId } from "./mcp-conformance/types.js";
export { MCP_APPS_CHECK_IDS } from "./apps-conformance/types.js";
export type { MCPAppsCheckId } from "./apps-conformance/types.js";
export { MCP_TASKS_CHECK_IDS } from "./tasks-conformance/types.js";
export type { MCPTasksCheckId } from "./tasks-conformance/types.js";
export { CONFORMANCE_CHECK_METADATA } from "./oauth-conformance/types.js";
export type { OAuthConformanceCheckId } from "./oauth-conformance/types.js";

// The shared verdict vocabulary and the score built on it. Both are pure data
// reasoning (no MCP client, no transport, no Node built-ins) — the score's
// suite adapters reach the result types through `import type` only.
export {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isInapplicableCheck,
  isUnrunCheck,
} from "./conformance-outcome.js";
export type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
  OutcomeCheckLike,
} from "./conformance-outcome.js";
export {
  computeConformanceScore,
  describeConformanceScore,
  pooledConformanceScore,
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
} from "./conformance-score.js";
export { toConformanceReport } from "./conformance-reporting.js";
export type {
  ConformanceReport,
  ConformanceReportCase,
  ConformanceReportGroup,
} from "./conformance-reporting.js";
export type {
  ConformanceAdvisoryTier,
  ConformanceScore,
  ScoredAdvisory,
} from "./conformance-score.js";
// The frozen scored-check manifest a score is computed over, plus the identity
// stamp that says which questions a given number came from. Pure data, so it
// ships from the browser entry alongside the score itself.
export {
  buildConformanceProfileStamp,
  conformanceProfile,
  conformanceProfileDigest,
  partitionByProfile,
  partitionByStamp,
  unscoredCheckIds,
  CONFORMANCE_CHECKER_VERSION,
  CONFORMANCE_PROFILE_IDS,
} from "./conformance-profile.js";
export type {
  ConformanceProfile,
  ConformanceProfileId,
  ConformanceProfileStamp,
  ProfileCheckLike,
} from "./conformance-profile.js";

// Redaction for reports that leave the machine that produced them (a stored,
// shareable run). Structural drop of raw HTTP evidence plus a credential-shaped
// key sweep — see the module header for why both layers exist.
export {
  REDACTED,
  redactConformanceReportForSharing,
  redactSharedServerUrl,
  redactUrlSecrets,
} from "./conformance-redaction.js";

// Each check's title and one-line description, kept byte-identical to the
// strings on the check implementations by `tests/conformance-catalog.test.ts`.
export {
  APPS_CHECK_CATALOG,
  PROTOCOL_CHECK_CATALOG,
  TASKS_CHECK_CATALOG,
} from "./conformance-catalog.js";
export type { ConformanceCheckInfo } from "./conformance-catalog.js";

export {
  buildConformanceRunReport,
  CONFORMANCE_RUN_SCHEMA_VERSION,
  CONFORMANCE_SUITE_KINDS,
  DEFAULT_CONFORMANCE_SUITES,
  normalizeConformanceSuites,
} from "./conformance-run-types.js";
export type {
  ConformanceRunReportV1,
  ConformanceSuiteKind,
} from "./conformance-run-types.js";

// Host-side sandbox policy resolver (SEP-1865 + ChatGPT Apps). Pure
// resolver — DOM-free, React-free, Convex-free. Browser-safe by
// construction. Re-exported here so client renderers can import it
// without pulling in Node-only entrypoints.
export {
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "./sandbox-policy.js";
export type {
  SandboxCspMode,
  SandboxPermissionsMode,
  SandboxCspDomainSet,
  SandboxCspPolicy,
  SandboxPermissionsPolicy,
  ResourceDeclaredCsp,
  EffectiveSandboxCsp,
  EffectiveSandboxPermissions,
  ResolveSandboxCspArgs,
  ResolveSandboxPermissionsArgs,
} from "./sandbox-policy.js";
// MCP protocol-version constants + predicates. Browser-safe by
// construction (pure data + pure functions, no Node deps).
export { cancellationLeafForVersion } from "./host-config/index.js";
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  protocolVersionLabel,
  type McpProtocolVersion,
} from "./mcp-client-manager/mcp-protocol-version.js";

// SEP-2243 mirrored request-metadata headers. Browser-safe by construction
// (pure string work, no transport): the Tracing panel runs the SAME decode and
// header/body cross-check a server runs, so a `-32020 HeaderMismatch` can be
// explained against the captured wire instead of guessed at.
export {
  MCP_HEADER_SENTINEL_PREFIX,
  MCP_HEADER_SENTINEL_SUFFIX,
  MCP_PARAM_HEADER_PREFIX,
  // Exported for the renderer's frame↔exchange correlation, which must treat
  // `params.taskId` as the `Mcp-Name` source for exactly the methods the
  // CAPTURE side does. A copy in the client would be a literal list `tsc`
  // cannot check against this one, and the tasks extension is versioned
  // independently of core — the set moves on its own schedule.
  TASK_ROUTED_METHODS,
  buildMcpParamHeaders,
  classifyMcpHeader,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  evaluateMcpHeaders,
  findMcpHeaderIssues,
  // The send-side scan, in the browser bundle because the Tracing panel now
  // judges `Mcp-Param-*` rows: deciding whether a captured header was
  // supposed to be there needs the tool's own `x-mcp-header` declarations,
  // read with the same walk that built the headers.
  scanXMcpHeaderDeclarations,
  stripXMcpHeaderAnnotations,
} from "./mcp-client-manager/mcp-header-mirror.js";
export type {
  DecodedMcpHeaderValue,
  McpHeaderAssessment,
  McpHeaderFamily,
  McpHeaderIssue,
  McpHeaderStatus,
  McpParamCrossCheck,
  MirroredBodyValues,
  XMcpHeaderDeclaration,
  XMcpHeaderScan,
} from "./mcp-client-manager/mcp-header-mirror.js";
export type { HttpExchangeLogEvent } from "./mcp-client-manager/http-exchange-log.js";

// OpenTelemetry trace context over the 2026-07-28 reserved `_meta` keys.
// Browser-safe by construction: pure string validation, no transport. The
// browser side is the READ half — surfacing a trace context a server sent so
// a user debugging it can see which trace their call joined. `baggage` here
// is untrusted, display-only data; it must never reach PostHog/Axiom.
export {
  BAGGAGE_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  extractTraceContext,
  isValidBaggage,
  isValidTraceparent,
  isValidTracestate,
  parseTraceparent,
  sanitizeTraceContext,
  traceContextToMeta,
} from "./mcp-client-manager/trace-context.js";
export type {
  ParsedTraceparent,
  TraceContext,
  TraceContextProvider,
} from "./mcp-client-manager/trace-context.js";

// HostConfig — the public `Host` builder (also at `@mcpjam/sdk/host-config`).
// Browser-safe: the class wraps the pure canonicalizer + Web Crypto hash.
// `McpProtocolVersion` is omitted here — already exported just above.
export { Host } from "./host-config/index.js";
export type {
  HostInit,
  HostJson,
  HostMcp,
  HostServerOverride,
  HostConnectionDefaults,
  HostStyleId,
  McpToolResultImageRendering,
  McpToolResultImageRenderingPolicy,
  McpToolResultImageRenderPlacement,
  ModelVisibleMcpToolResults,
  ServerId,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
  ToolParamHeaderMirroring,
  PaginationTraversalMode,
  MrtrSupport,
} from "./host-config/index.js";

// Shared task lifecycle engine. Browser-safe by construction: it performs no
// I/O at all — it decides *when* a task may next be polled and remembers what
// was last seen, while the caller owns the transport. That is exactly what
// lets the Tasks tab, a Hono route and the CLI share one scheduler.
export {
  TaskLifecycleEngine,
  taskLifecycleKey,
  isTerminalLifecycleStatus,
  toSnapshot as toTaskLifecycleSnapshot,
  TERMINAL_LIFECYCLE_STATUSES,
} from "./mcp-client-manager/task-lifecycle.js";
export type {
  LiveTasksWire,
  TaskLifecycleCallbacks,
  TaskLifecycleEngineOptions,
  TaskLifecycleError,
  TaskLifecycleIdentity,
  TaskLifecycleObservation,
  TaskLifecycleRecord,
  TaskLifecycleSnapshot,
  TaskLifecycleStatus,
  TaskObservationSource,
} from "./mcp-client-manager/task-lifecycle.js";
export {
  extensionTaskToObservation,
  legacyTaskToObservation,
  isUnknownTaskError,
  isTasksDeclarationRequiredError,
  parseRetryAfterMs,
  UNKNOWN_TASK_ERROR_CODE,
  TASKS_DECLARATION_REQUIRED_ERROR_CODE,
} from "./mcp-client-manager/task-lifecycle-adapters.js";

// Tasks product policy — pure predicates over the stored host config, so the
// editor and every browser-side surface read the same tri-state.
export {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  readTasksPolicy,
  describeInvalidTasksPolicy,
  setTasksPolicy,
  clearTasksPolicy,
  taskModeForSurface,
  surfaceMayDeclareTasks,
} from "./host-config/tasks-policy.js";
export type {
  TasksPolicy,
  TaskMode,
  TaskSurface,
} from "./host-config/tasks-policy.js";

// Skills over MCP (SEP-2640) — the browser-safe halves only. The dispatch
// gate is pure predicates over capability objects, and the integrity helpers
// are WebCrypto-backed by construction (never `node:crypto`), so the Skills
// tab and the host builder can verify and classify without a server round
// trip. The wire module (`skills-ext.ts`) is deliberately NOT here: sending
// requires a connected `ManagedMcpClient`, which is a server-side object.
export { withSkillsExtensionCapability } from "./mcp-client-manager/capabilities.js";
export {
  MCP_SKILLS_EXTENSION_ID,
  clientDeclaresSkillsExtension,
  resolveSkillsSupport,
  serverDeclaresSkillsExtension,
  skillsDirectoryReadEnabled,
} from "./mcp-client-manager/skills-dispatch.js";
export type { SkillsSupport } from "./mcp-client-manager/skills-dispatch.js";
export {
  SkillIntegrityError,
  isSkillIntegrityError,
  canonicalJson as canonicalSkillJson,
  checkFrontmatterDrift,
  checkSkillIdentity,
  comparableAdvertisedFrontmatter,
  splitAdvertisedFrontmatter,
  computeSkillVersionHash,
  findListedResource,
  isListedResource,
  parseDigest,
  sha256HexOfBytes,
  sha256HexOfText,
  skillNameFromUri,
  splitSkillMarkdown,
  verifyDigest,
  verifySkillMarkdown,
} from "./mcp-client-manager/skills-integrity.js";
export type {
  DigestVerification,
  FrontmatterIdentityCheck,
  ParsedDigest,
  SupportedDigestAlgorithm,
} from "./mcp-client-manager/skills-integrity.js";
export type {
  SkillEntry,
  SkillResourceRef,
  SkillsExtListResult,
  SkillIdentityFrontmatter,
} from "./mcp-client-manager/skills-ext-types.js";
export { modelRejectsTemperature } from "./model-sampling-support.js";
