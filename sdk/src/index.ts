/**
 * @mcpjam/sdk - MCP server unit testing, end to end (e2e) testing, and server evals
 *
 * @packageDocumentation
 */

// MCPClientManager from new modular implementation
export { MCPClientManager } from "./mcp-client-manager/index.js";

// Server configuration types
export type {
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  MCPServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  BaseServerConfig,
} from "./mcp-client-manager/index.js";

// Connection state types
export type {
  MCPConnectionStatus,
  ServerSummary,
  MCPServerSummary,
  RegisteredServerState,
  LiveClientState,
  UnauthorizedRefreshHandler,
  UnauthorizedRefreshResult,
} from "./mcp-client-manager/index.js";

// Handler and callback types
export type {
  ElicitationHandler,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
  HttpExchangeLogEvent,
  HttpExchangeLogger,
} from "./mcp-client-manager/index.js";

// SEP-2243 `x-mcp-header` → `Mcp-Param-*` mirroring helpers. The send path
// uses these internally; they are public so the CLI and the conformance
// runner judge tool declarations with the SAME walk the wire does.
export {
  buildMcpParamHeaders,
  classifyMcpHeader,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  scanXMcpHeaderDeclarations,
  stripXMcpHeaderAnnotations,
} from "./mcp-client-manager/index.js";
export type {
  McpParamCrossCheck,
  XMcpHeaderDeclaration,
  XMcpHeaderScan,
} from "./mcp-client-manager/index.js";

// Tool and task types
// The schema validator the manager itself uses for elicitation content, so a
// downstream surface can check an answer against the same authority it will be
// judged by instead of reimplementing (and drifting from) its configuration.
export {
  DialectAwareJsonSchemaValidator,
  CspSafeDialectAwareJsonSchemaValidator,
} from "./mcp-client-manager/index.js";

export type {
  Tool,
  ToolExecuteOptions,
  AiSdkTool,
  ExecuteToolArguments,
  ExecuteToolRequest,
  TaskOptions,
  ClientCapabilityOptions,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
  ListToolsResult,
} from "./mcp-client-manager/index.js";

// MCP result types
export type {
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
} from "./mcp-client-manager/index.js";

// Tool result scrubbing utilities (for MCP Apps)
export {
  isChatGPTAppTool,
  isMcpAppTool,
  MCP_DIRECT_IMAGE_MAX_BYTES,
  MCP_IMAGE_MAX_MEDIA_PARTS,
  MCP_IMAGE_MAX_TOTAL_BYTES,
  MCP_LINKED_RESOURCE_MAX_READS,
  MCP_PRESERVE_RAW_RESULT_FOR_UI,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
  type McpModelOutputOptions,
  type McpModelOutputWithLinkedResourcesOptions,
  type McpModelVisibleToolResultPolicy,
  type McpLinkedResourceReader,
} from "./mcp-client-manager/index.js";
export {
  applyRuntimeClientCapabilities,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
  withSkillsExtensionCapability,
} from "./mcp-client-manager/index.js";

// io.modelcontextprotocol/skills (SEP-2640).
export {
  MCP_SKILLS_EXTENSION_ID,
  SKILL_NOT_FOUND_ERROR_CODE,
  SkillsExtDirectoryReadMethod,
  SkillsExtGetMethod,
  SkillsExtListMethod,
  INODE_DIRECTORY_MIME_TYPE,
  DYNAMIC_SKILL_RESOURCES,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
  clientDeclaresSkillsExtension,
  resolveSkillsSupport,
  serverDeclaresSkillsExtension,
  skillsDirectoryReadEnabled,
  isSkillNotFoundError,
  InvalidSkillsPayloadError,
  isInvalidSkillsPayloadError,
  MCPSkillsWireError,
  isMCPSkillsWireError,
  assertSkillEntry,
  assertSkillsGetResult,
  assertSkillsListResult,
  assertDirectoryReadResult,
  SkillIntegrityError,
  isSkillIntegrityError,
  // Aliased to match the browser entrypoint: one symbol with two public names
  // is a trap, and `canonicalJson` is too broad for a skills-specific
  // serializer.
  canonicalJson as canonicalSkillJson,
  checkFrontmatterDrift,
  checkSkillIdentity,
  comparableAdvertisedFrontmatter,
  splitAdvertisedFrontmatter,
  computeSkillVersionHash,
  checkManifestLimits,
  enumeratedResources,
  findListedResource,
  isDynamicResources,
  isListedResource,
  parseDigest,
  sha256HexOfBytes,
  sha256HexOfText,
  skillNameFromUri,
  splitSkillMarkdown,
  verifyDigest,
  verifySize,
  verifySkillMarkdown,
} from "./mcp-client-manager/index.js";
export type {
  SkillEntry,
  SkillResourceRef,
  SkillsExtListResult,
  SkillsDirectoryEntry,
  SkillsDirectoryReadResult,
  SkillIdentityFrontmatter,
  SkillsSupport,
  DigestVerification,
  FrontmatterIdentityCheck,
  ParsedDigest,
  SupportedDigestAlgorithm,
} from "./mcp-client-manager/index.js";

// Skills over MCP (SEP-2640) — the VERIFIED READ PATH.
//
// The orchestration above the integrity primitives: every SKILL.md fetched via
// `resources/read` and digest-checked before a caller sees a byte, the manifest
// enforced as the read allowlist, and each server behaviour mapped to a named
// refusal. Exported here rather than behind a subpath because every consumer
// already imports from the package root.
export {
  EXTENSION_INACTIVE_REFUSAL,
  MAX_SERVER_SKILL_READ_BYTES,
  ServerSkillRefusalError,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  normalizeCatalogText,
  probeServerSkillMissing,
  readVerifiedServerSkillFile,
  serverSkillsActive,
} from "./server-skills.js";
export type {
  ServerSkillListing,
  ServerSkillRefusal,
  ServerSkillSummary,
  ServerSkillsLogger,
  VerifiedServerSkill,
} from "./server-skills.js";
export { cancellationLeafForVersion } from "./host-config/index.js";
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  protocolVersionLabel,
  type McpProtocolVersion,
} from "./mcp-client-manager/index.js";

// Response cache (SEP-2549) — per-call disposition + serve provenance
export type {
  CacheMode,
  CacheScope,
  CacheHitEvent,
  CacheEventLogger,
} from "./mcp-client-manager/index.js";
// Phase 5 auto-negotiation-activation telemetry (new exports only).
export type {
  NegotiationOutcomeEvent,
  NegotiationOutcomeLogger,
  ConfiguredNegotiationMode,
} from "./mcp-client-manager/index.js";
export {
  ObservableResponseCache,
  type ObservableResponseCacheOptions,
} from "./mcp-client-manager/index.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
  isUnauthorized401,
  isInsufficientScopeError,
  extractInsufficientScopeChallenge,
  unwrapEraNegotiationCause,
  classifyNegotiationFailureClass,
  MCPTasksWireError,
  isMCPTasksWireError,
} from "./mcp-client-manager/index.js";
export type { InsufficientScopeChallenge } from "./mcp-client-manager/index.js";
export type { RetryPolicy } from "./retry.js";
export {
  DEFAULT_RETRY_POLICY,
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryWithPolicy,
} from "./retry.js";
export { EvalReportingError, SdkError } from "./errors.js";
export { probeMcpServer } from "./server-probe.js";
export type {
  ProbeHttpAttempt,
  ProbeInitializeInfo,
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
  ProbeOAuthDetails,
  ProbeTransportResult,
} from "./server-probe.js";
export {
  runServerDoctor,
  collectConnectedServerDoctorState,
  normalizeServerDoctorError,
} from "./server-doctor.js";
export type {
  ServerDoctorError,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorResult,
  ConnectedServerDoctorState,
  RunServerDoctorInput,
  ServerDoctorDependencies,
} from "./server-doctor.js";
export {
  collectServerSnapshot,
  collectConnectedServerSnapshot,
  normalizeServerSnapshot,
  serializeServerSnapshot,
  serializeStableServerSnapshot,
  ServerSnapshotFormatError,
} from "./server-snapshot.js";
export type {
  CollectServerSnapshotInput,
  CollectedServerSnapshot,
  RawServerSnapshot,
  StableServerSnapshot,
  NormalizedServerSnapshot,
  ServerSnapshotTool,
  ServerSnapshotResource,
  ServerSnapshotResourceTemplate,
  ServerSnapshotPrompt,
  ServerSnapshotDependencies,
} from "./server-snapshot.js";
export {
  diffServerSnapshots,
  collectAndDiffServerSnapshot,
  buildServerDiffReport,
} from "./server-diff.js";
export type {
  SnapshotDiffClassification,
  SnapshotDiffEntityType,
  SnapshotDiffChangeType,
  SnapshotDiffFailOn,
  SnapshotFieldChange,
  SnapshotEntityChange,
  SnapshotEntityClassificationSummary,
  SnapshotDiffSummary,
  SnapshotSurfaceSummary,
  ServerSnapshotDiffResult,
  DiffServerSnapshotsOptions,
  CollectAndDiffServerSnapshotInput,
} from "./server-diff.js";
// Adapts a run comparison into the same StructuredRunReport the server-diff
// reporter uses, so `--reporter junit-xml` needs no second renderer.
export { buildRunCompareReport } from "./run-compare.js";
// Already the p95 the gate engine uses internally. Exported so the CLI's
// compare command computes latency the SAME way rather than growing a second
// percentile implementation next to it.
export { calculateLatencyStats, calculatePercentile } from "./percentiles.js";

// Hosted corpus: materialize eval cases into local EvalTests, and lock what was
// materialized. Pure — the file I/O half lives in @mcpjam/cli.
export {
  CORPUS_LOCK_VERSION,
  HostedOnlyCaseError,
  buildCorpus,
  buildCorpusLock,
  evalTestFromPlatformCase,
  loadCorpusFromLock,
  resolveCaseNames,
  resolveEffectiveChecks,
  scenarioContentHash,
  sdkMatchOptionsFromPublic,
  verifyCorpusLock,
} from "./corpus.js";
export type {
  BuildCorpusInput,
  CorpusCase,
  CorpusDrift,
  CorpusLock,
  CorpusSkip,
  EvalTestFromCaseOptions,
  LoadedCorpus,
  PublicCheckOverride,
  PublicMatchOptions,
} from "./corpus.js";

// Suite files: read one, resolve its documented defaults in memory, write an
// authored one back. Pure and browser-safe — the file I/O half lives in
// @mcpjam/cli (`eval validate`, `eval export`).
//
// Deliberately NOT re-exported from `@mcpjam/sdk/contract`. That subpath is
// dependency-light (zod only) and browser-bundled on purpose; routing the
// loader through it would pull `yaml` into every client bundle that imports
// the contract for its types.
export {
  MAX_SUITE_FILE_BYTES,
  SUITE_FILE_DEFAULT_CAPTURE_LEVEL,
  SUITE_FILE_DEFAULT_COVERAGE,
  SUITE_FILE_FINDING_CODES,
  SUITE_FILE_VALIDITY_DEFAULTS,
  declareEvalSuiteFileValidity,
  formatSuiteFileFindings,
  loadEvalSuiteFile,
  resolveEvalSuiteFile,
  serializeEvalSuiteFile,
  suiteFilePointer,
} from "./suite-file-loader.js";
export type {
  LoadEvalSuiteFileOptions,
  ResolvedEvalSuiteFile,
  ResolvedEvalSuiteFileCase,
  ResolvedEvalSuiteFileValidity,
  SuiteFileFailureStage,
  SuiteFileFinding,
  SuiteFileFindingCode,
  SuiteFileLoadFailure,
  SuiteFileLoadResult,
  SuiteFileLoadSuccess,
  SuiteFileLocation,
} from "./suite-file-loader.js";
export type { LatencyStats } from "./percentiles.js";
export {
  validateToolCallEnvelope,
  evaluateToolCallOutcome,
  validateToolCallResult,
  buildToolCallValidationReport,
} from "./response-validation.js";
export type {
  ToolCallEnvelopeValidationDetails,
  ToolCallEnvelopeValidationResult,
  ToolCallOutcomePolicy,
  ToolCallOutcomeEvaluationResult,
  ToolCallValidationResult,
} from "./response-validation.js";
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
  buildEvalRunReport,
  summarizeStructuredCases,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  renderStructuredRunHtml,
} from "./structured-reporting.js";
export {
  buildEvalDecisionSummary,
  buildEvalDecisionSummaryFromIterations,
  buildEvalRunDecisionSummary,
  DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  formatEvalDecisionSummary,
  formatEvalRunDecisionSummary,
  NEXT_ACTION_BY_FAILURE_CATEGORY,
  readEvalRunDecisionSummary,
} from "./eval-decision-summary.js";
export type { FormatEvalRunDecisionSummaryOptions } from "./eval-decision-summary.js";
/**
 * The canonical run decision contract, re-exported from `@mcpjam/sdk/contract`.
 *
 * Mirrored onto the main entry because the CLI and the reporters consume it
 * beside the platform types, and making them import one shape from two subpaths
 * is how a consumer ends up with two copies of the type at different versions.
 */
export {
  assembleEvalRunDecisionSummary,
  EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION,
  evalRunDecisionSummarySchema,
} from "./contract/index.js";
export type {
  EvalRunDecisionCounts,
  EvalRunDecisionDiagnostic,
  EvalRunDecisionSummary,
  EvalRunDecisionVerdict,
} from "./contract/index.js";
export type {
  EvalDecisionSummary,
  EvalDecisionSummaryCase,
  EvalDecisionSummaryInput,
  EvalDecisionVerdict,
  NormalizedEvalDecisionCase,
  StageChainStatus,
} from "./eval-decision-summary.js";
export type {
  StructuredEvalRunInput,
  StructuredCaseClassification,
  StructuredCaseResult,
  StructuredCaseWaiver,
  StructuredSummaryBucket,
  StructuredRunSummary,
  StructuredRunReport,
  StructuredRunVerdict,
} from "./structured-reporting.js";
export {
  toConformanceReport,
  renderConformanceReportJson,
  renderConformanceReportJUnitXml,
} from "./conformance-reporting.js";
export type {
  ConformanceReport,
  ConformanceReportAdvisory,
  ConformanceReportCase,
  ConformanceReportCaseStatus,
  ConformanceReportGroup,
  ConformanceReportKind,
  SupportedConformanceResult,
} from "./conformance-reporting.js";

// The publisher-neutral readiness algebra. Named rather than `export *`
// because both publisher barrels below already re-export parts of it under
// their own names, and a wildcard would collide with them.
export {
  DIRECTORY_OBSERVATION_CONFIDENCE,
  DIRECTORY_OBSERVATION_FINDING_CLASSES,
  DIRECTORY_OBSERVATION_LIMITS,
  DIRECTORY_OBSERVATION_REASONS,
  DIRECTORY_OBSERVATION_STATUSES,
  NOT_REQUESTED_OBSERVATIONS,
  mapObservationsToFindings,
  observationFailure,
  parseDirectoryObservationEnvelope,
} from "./directory-readiness/observations.js";
export type {
  DirectoryObservation,
  DirectoryObservationCatalog,
  DirectoryObservationConfidence,
  DirectoryObservationEnvelope,
  DirectoryObservationFindingClass,
  DirectoryObservationMapping,
  DirectoryObservationParseFailure,
  DirectoryObservationParseResult,
  DirectoryObservationReason,
  DirectoryObservationSchema,
  DirectoryObservationState,
  DirectoryObservationStatus,
} from "./directory-readiness/observations.js";

export {
  EVIDENCE_REUSE_REFUSALS,
  checkEvidenceReuse,
  sameReadinessTarget,
} from "./directory-readiness/evidence-reuse.js";
export type {
  AttributableEvidenceSource,
  EvidenceReuse,
  EvidenceReuseExpectation,
  EvidenceReuseRefusal,
} from "./directory-readiness/evidence-reuse.js";

// The shared MCP dial. NODE ENTRY ONLY — it opens sockets, so it is absent
// from `browser.ts` and from the two publisher barrels, exactly like the
// discovery modules below.
export {
  DIRECTORY_DIAL_CLIENT_INFO,
  DIRECTORY_DIAL_DEFAULTS,
  DIRECTORY_DIAL_PROTOCOL_VERSION,
  dialAppResources,
  dialInitialize,
  dialMcpServer,
  dialResourceListing,
  dialToolListing,
} from "./directory-readiness/mcp-dial.js";
export type {
  DirectoryAppResourceEvidence,
  DirectoryDialEvidence,
  DirectoryDialOptions,
  DirectoryDialRequest,
  DirectoryInitializeEvidence,
  DirectoryListingEvidence,
  DirectoryResourceEvidence,
  DirectoryToolEvidence,
} from "./directory-readiness/mcp-dial.js";

// Claude directory readiness. Pure data and data reasoning only — the runner
// and the dialing checks are deliberately not re-exported here, so importing
// the result model never pulls a transport in with it.
export * from "./claude-readiness/index.js";
// The one readiness module that touches the network, exported only from the
// Node entry. It is deliberately absent from `claude-readiness/index.ts` so
// that importing the result model can never pull a transport in with it.
export {
  discoverClaudeAuthEvidence,
  traceConnectorRedirects,
} from "./claude-readiness/discovery.js";
export type { ClaudeDiscoveryOptions } from "./claude-readiness/discovery.js";
// The Claude gather half, Node-only for the same reason as the discovery
// module above: it dials, and importing a result model must never pull a
// transport in with it.
export { gatherClaudeReadinessEvidence } from "./claude-readiness/gather.js";
export type { GatherClaudeReadinessEvidenceOptions } from "./claude-readiness/gather.js";
// The side-effecting intrusive probes, likewise Node-only. The gate that arms
// them and the grading that reads them are pure and come from the barrel above.
export {
  probeDynamicRegistration,
  probeRefreshRotation,
} from "./claude-readiness/intrusive-probes.js";

// OpenAI plugin-directory readiness. Same rule as the Claude barrel above:
// pure data and data reasoning only, so importing the result model or the
// package reader never pulls a transport in with it.
export * from "./openai-readiness/index.js";
// The Node plugin-bundle file sources: a directory on disk and a ZIP in
// memory. NODE ENTRY ONLY — they are the only `plugin-bundle` modules that
// touch `node:fs` or an archive library, and `plugin-bundle/index.ts` stays
// free of both so a browser can still validate a dropped package in the page.
export {
  DIRECTORY_ARCHIVE_OBSERVATIONS,
  collectZipArchiveObservations,
  createDirectoryPluginFileSource,
  createZipPluginFileSource,
} from "./plugin-bundle/node-file-sources.js";

// The Node XML parser for SVG dimension reads, exported ONLY here. A browser
// has `DOMParser` natively and `readImageDimensions` finds it; `@xmldom/xmldom`
// is banned from the browser entry's import graph, so the Node fallback lives
// behind this entry and is passed in as `parseXml`.
export { xmldomParseXml } from "./openai-readiness/package/svg-xml-node.js";

// The OpenAI readiness modules that touch the network, exported only from the
// Node entry. They are deliberately absent from `openai-readiness/index.ts` so
// that importing the result model can never pull a transport in with it.
export {
  discoverOpenAIAuthEvidence,
  discoverOpenAIImportedSkills,
  fetchOpenAIDomainVerification,
  traceOpenAIEndpoint,
} from "./openai-readiness/discovery.js";
export type {
  OpenAIAuthEvidence,
  OpenAIAuthorizationServerEvidence,
  OpenAIDiscoveryOptions,
  OpenAIDomainVerificationEvidence,
  OpenAIEndpointEvidence,
} from "./openai-readiness/discovery.js";
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
export type {
  ConformanceAdvisoryTier,
  ConformanceScore,
  ScoredAdvisory,
} from "./conformance-score.js";
// The frozen scored-check manifest a score is computed over, plus the identity
// stamp that says which questions a given number came from.
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
export { runConformance } from "./conformance-run.js";
export type {
  ConformanceRunProgress,
  RunConformanceConfig,
} from "./conformance-run.js";
export {
  detectConformanceCiMetadata,
  githubActionExternalRunId,
} from "./conformance-ci.js";
export type { ConformanceCiMetadata } from "./conformance-ci.js";
export {
  finalizeConformanceRun,
  heartbeatConformanceRun,
  isConformanceReportingConfigured,
  reportConformanceRun,
  reportConformanceRunSafely,
  startConformanceRun,
  uploadConformanceSuiteReport,
} from "./report-conformance-run.js";
export type {
  ConformanceRunSource,
  ConformanceTargetInput,
  ReportConformanceRunOptions,
  ReportConformanceRunOutput,
} from "./report-conformance-run.js";
export { createConformanceRunReporter } from "./conformance-run-reporter.js";
export type { ConformanceRunReporter } from "./conformance-run-reporter.js";
// Redaction for reports that leave the machine that produced them (a stored,
// shareable run). Structural drop of raw HTTP evidence plus a credential-shaped
// key sweep — see the module header for why both layers exist.
export {
  REDACTED,
  redactConformanceReportForSharing,
  redactSharedServerUrl,
  redactUrlSecrets,
} from "./conformance-redaction.js";
export { runOAuthLogin } from "./oauth-login.js";
export type {
  OAuthLoginConfig,
  OAuthLoginDependencies,
  OAuthLoginResult,
} from "./oauth-login.js";
// Loopback authorization-code capture + PKCE primitives, reused by the CLI's
// platform login (`mcpjam cloud login`) in addition to OAuth conformance runs.
export {
  createInteractiveAuthorizationSession,
  openUrlInBrowser,
  type InteractiveAuthorizationSession,
} from "./oauth-conformance/auth-strategies/interactive.js";
export {
  generateCodeChallenge,
  generateRandomString,
} from "./oauth/state-machines/shared/pkce.js";
export { runOAuthStateMachine } from "./oauth/state-machines/runner.js";
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
export {
  isInvalidRedirectUriRejection,
  planCompletionSafeRedirects,
} from "./oauth/emulation/redirects.js";
export type { CompletionSafeRedirectPlan } from "./oauth/emulation/redirects.js";
// Node-only: runs the emulated ladder over the hardened OAuth networking path.
export { runEmulatedOAuthPreflight } from "./oauth/emulation/preflight.js";
export type {
  EmulatedAuthAttemptResult,
  EmulatedOAuthPreflightConfig,
  EmulatedOAuthPreflightOutcome,
  EmulatedOAuthPreflightResult,
} from "./oauth/emulation/preflight.js";
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
// XAA (ID-JAG) client identity + shared client registration. Exported from
// the Node entry too: the inspector server hosts the XAA client-metadata
// document and needs the builder/evaluator server-side.
export {
  ID_JAG_GRANT_PROFILE,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  SAML2_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_IDP_CLIENT_ID,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  XAA_CONFIDENTIAL_CIMD_ORIGIN,
  XAA_CONFIDENTIAL_CIMD_PATH_PREFIX,
  buildConfidentialCimdUrl,
  decodeConfidentialCimdKey,
  getConfidentialCimdReflectorMetadata,
  UNVERIFIED_CONFIDENTIAL_CIMD_CLIENT_NAME,
  evaluateIdJagClientMetadata,
  getXaaConnectClientMetadata,
  getXaaDebugClientMetadata,
} from "./oauth/client-identity.js";
export {
  initXaaClientKeyPair,
  getXaaClientJwks,
  resetXaaClientKeyPairForTests,
  XAA_CLIENT_KID,
} from "./xaa/mint/client-keypair.js";
export type {
  IdJagClientMetadataEvaluation,
  IdJagMetadataEvidence,
} from "./oauth/client-identity.js";
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
  isLoopbackHost,
  isLoopbackClientMetadataUrl,
} from "./oauth/state-machines/shared/client-id-metadata.js";
export {
  decodeJWT,
  decodeJWTParts,
  formatJWTTimestamp,
} from "./oauth/state-machines/shared/jwt.js";
export type { DecodedJwtParts } from "./oauth/state-machines/shared/jwt.js";

// XAA (Cross-App Access / ID-JAG) mock-IdP mint — node-only (crypto/fs).
// Consumed by the inspector server and the CLI's headless `runXaaFlow`.
export * from "./xaa/index.js";

// HostExecutor interface (for deterministic testing without concrete HostRunner)
export type { HostExecutor, PromptOptions } from "./HostExecutor.js";

// AI SDK stop condition helpers re-exported for HostRunner.run()
export { hasToolCall, stepCountIs } from "ai";
export type { StopCondition } from "ai";

// HostRunner
export { HostRunner } from "./HostRunner.js";
export type { HostRunnerConfig } from "./HostRunner.js";

// PromptResult class (preferred over HostRunner's interface)
export { PromptResult } from "./PromptResult.js";

// Validators for tool call matching
export {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchToolCallCount,
  matchNoToolCalls,
  // Argument-based validators (Phase 2.5)
  matchToolCallWithArgs,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "./validators.js";

// EvalTest - Single test that can run standalone
export { EvalTest } from "./EvalTest.js";
export type {
  EvalTestConfig,
  EvalTestRunOptions,
  EvalRunResult,
  IterationResult,
} from "./EvalTest.js";

// EvalSuite - Groups multiple EvalTests
export { EvalSuite } from "./EvalSuite.js";
export type {
  EvalSuiteConfig,
  EvalSuiteResult,
  TestResult,
} from "./EvalSuite.js";

// Eval reporting APIs (DX-first ingestion)
export {
  reportEvalResults,
  reportEvalResultsSafely,
} from "./report-eval-results.js";
export { createEvalRunReporter } from "./eval-run-reporter.js";
export type {
  CreateEvalRunReporterInput,
  EvalRunReporter,
} from "./eval-run-reporter.js";
export { uploadEvalArtifact } from "./upload-eval-artifact.js";
export type {
  UploadEvalArtifactInput,
  EvalArtifactFormat,
} from "./upload-eval-artifact.js";
export type {
  EvalExpectedToolCall,
  EvalCiMetadata,
  EvalTraceInput,
  EvalTraceSpanCategory,
  EvalTraceSpanInput,
  EvalWidgetCsp,
  EvalWidgetPermissions,
  EvalWidgetSnapshotInput,
  EvalResultInput,
  MCPServerReplayConfig,
  MCPJamReportingConfig,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";

export {
  finalizePassedForEval,
  isCallToolResultError,
  traceIndicatesToolExecutionFailure,
  traceMessagePartIndicatesToolFailure,
} from "./eval-tool-execution.js";
export type { FinalizeEvalPassedParams } from "./eval-tool-execution.js";

// Eval result mapping utilities
export type {
  PromptsToEvalResultOverrides,
  RunToEvalResultsOptions,
  SuiteRunToEvalResultsOptions,
} from "./eval-result-mapping.js";
export { promptsToEvalResult } from "./eval-result-mapping.js";

// Core SDK types
export type {
  LLMProvider,
  CompatibleProtocol,
  CustomProvider,
  LLMConfig,
  ToolCall,
  TokenUsage,
  LatencyBreakdown,
  PromptResultData,
  // AI SDK message types (re-exported for convenience)
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolMessage,
} from "./types.js";

// Model factory utilities
export {
  parseLLMString,
  createModelFromString,
  parseModelIds,
  createCustomProvider,
  PROVIDER_PRESETS,
} from "./model-factory.js";
export type {
  BaseUrls,
  CreateModelOptions,
  ParsedLLMString,
  ProviderLanguageModel,
} from "./model-factory.js";

// Which sampling parameters a model accepts. Also exported from
// `@mcpjam/sdk/browser` so client code can gate a temperature control without
// pulling the Node graph in; exported here so a Node consumer building its own
// request doesn't re-derive the version thresholds locally.
export { modelRejectsTemperature } from "./model-sampling-support.js";

// Widget helpers (for injecting OpenAI compat runtime into MCP App HTML)
export {
  serializeForInlineScript,
  injectOpenAICompat,
  extractBaseUrl,
  generateUrlPolyfillScript,
  WIDGET_BASE_CSS,
  buildRuntimeConfigScript,
  injectScripts,
  normalizeWidgetCspMeta,
  buildCspHeader,
  buildCspMetaContent,
  buildChatGptRuntimeHead,
} from "./widget-helpers.js";
export type { CspMode, WidgetCspMeta, CspConfig } from "./widget-helpers.js";

// Host-side sandbox policy resolver (SEP-1865 + ChatGPT Apps). Pure
// resolver consumed by both client-side renderers and server-side route
// handlers that build CSP / permission policy for untrusted UI.
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

// OAuth proxy helpers (shared by inspector server routes and the CLI)
export {
  OAuthProxyError,
  validateUrl,
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
} from "./oauth-proxy.js";
export type { OAuthProxyRequest, OAuthProxyResponse } from "./oauth-proxy.js";

// Skill reference (SKILL.md content for agent brief generation)
export { EXPLORE_TO_SDK_EVALS_SKILL_MD, SKILL_MD } from "./skill-reference.js";

// Error describer — single source of truth for friendly error titles,
// likely causes, next steps, and docs anchors. Browser-safe; mirrored on
// `@mcpjam/sdk/browser` so client code can call `describeError` without
// dragging in Node-only deps.
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

// OAuth conformance
export {
  OAuthConformanceTest,
  OAuthConformanceSuite,
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  createRemoteBrowserAuthorizationController,
  normalizeCustomHeaders,
  oauthConformanceProfileSchema,
} from "./oauth-conformance/index.js";
export type {
  ConformanceResult as OAuthConformanceResult,
  ConformanceStepId as OAuthConformanceStepId,
  OAuthConformanceCheckId,
  OAuthConformanceProfile,
  RemoteBrowserAuthorizationCode,
  RemoteBrowserAuthorizationController,
  RemoteBrowserAuthorizationControllerOptions,
  RemoteBrowserAuthorizationInput,
  StepResult as OAuthConformanceStepResult,
  VerificationResult as OAuthVerificationResult,
} from "./oauth-conformance/index.js";

// MCP conformance
export {
  MCPConformanceTest,
  MCPConformanceSuite,
} from "./mcp-conformance/index.js";
export type {
  MCPCheckCategory,
  MCPCheckEra,
  MCPCheckEras,
  MCPCheckId,
  MCPCheckResult,
  MCPCheckStatus,
  MCPConformanceConfig,
  MCPConformanceResult,
  MCPConformanceSuiteConfig,
  MCPConformanceSuiteResult,
  MCPReadinessId,
  MCPReadinessSpecStrength,
  MCPReadinessWarning,
  MCPServerSurfaceSnapshot,
} from "./mcp-conformance/index.js";
export {
  CHECK_ERAS,
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSION_ERA_IDS,
  MCP_READINESS_IDS,
  PROTOCOL_VERSION_ERAS,
  canRunConformance,
  isHttpServerConfig,
} from "./mcp-conformance/index.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
  MCPConformanceFixtures,
} from "./mcp-conformance/index.js";
// Wire-schema validation: the run-wide message record and the validator that
// grades it against the revision's published JSON Schema. Node-only (Ajv),
// which is why it is absent from `@mcpjam/sdk/browser`.
export {
  WireObservationRecorder,
  WireSchemaValidator,
  CORE_WIRE_SCHEMAS,
  EXTENSION_SCHEMA_REVISIONS,
  EXTENSION_WIRE_SCHEMAS,
  TASKS_EXTENSION_ID,
} from "./mcp-conformance/index.js";
export type {
  ObservedRequestId,
  ObservedWireMessage,
  WireSchemaDocument,
  WireSchemaValidationReport,
  WireSchemaViolation,
} from "./mcp-conformance/index.js";

// MCP Apps conformance
export {
  MCPAppsConformanceTest,
  MCPAppsConformanceSuite,
} from "./apps-conformance/index.js";
export type {
  MCPAppsCheckCategory,
  MCPAppsCheckId,
  MCPAppsCheckResult,
  MCPAppsCheckStatus,
  MCPAppsConformanceConfig,
  MCPAppsConformanceResult,
  MCPAppsConformanceSuiteConfig,
  MCPAppsConformanceSuiteDefaults,
  MCPAppsConformanceSuiteResult,
  MCPAppsConformanceSuiteRun,
  MCPAppsResourceReadOutcome,
} from "./apps-conformance/index.js";
export {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
} from "./apps-conformance/index.js";

// MCP Tasks conformance
export { MCPTasksConformanceTest } from "./tasks-conformance/index.js";
export type {
  MCPTasksCheckCategory,
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksCheckStatus,
  MCPTasksConformanceConfig,
  MCPTasksConformanceResult,
  MCPTasksRunOutcome,
  MCPTasksSkipReason,
} from "./tasks-conformance/index.js";
export {
  decideOutcome,
  MCP_TASKS_CHECK_CATEGORIES,
  MCP_TASKS_CHECK_IDS,
  resolveProbeTool,
} from "./tasks-conformance/index.js";

// MCP Tasks runtime — the lifecycle engine, the wire adapters, the creation
// fan-out, the `await` driver, and the tool-call seam. Previously reachable
// only through `@mcpjam/sdk/browser`, which left every Node consumer (the
// inspector server, the CLI) re-deriving these rules locally.
export {
  TaskLifecycleEngine,
  taskLifecycleKey,
  isTerminalLifecycleStatus,
  toTaskLifecycleSnapshot,
  TERMINAL_LIFECYCLE_STATUSES,
  extensionTaskToObservation,
  legacyTaskToObservation,
  isUnknownTaskError,
  isTasksDeclarationRequiredError,
  parseRetryAfterMs,
  UNKNOWN_TASK_ERROR_CODE,
  TASKS_DECLARATION_REQUIRED_ERROR_CODE,
  TaskCreatedSink,
  driveTaskToTerminal,
  runToolTaskSeam,
  toolTaskSeamOptionsFor,
  TASK_SEAM_META_KEY,
  isCreateTaskExtResult,
  assertCreateTaskExtResult,
  assertGetTaskExtResult,
  InvalidTaskExtPayloadError,
  isInvalidTaskExtPayloadError,
  resolveTasksSupport,
} from "./mcp-client-manager/index.js";
export type {
  LiveTasksWire,
  TaskLifecycleIdentity,
  TaskLifecycleObservation,
  TaskLifecycleSnapshot,
  TaskLifecycleStatus,
  TaskCreatedConsumer,
  TaskCreatedEvent,
  TaskCreationSurface,
  TaskAwaitOutcome,
  TaskAwaitResult,
  ToolTaskAwaitOptions,
  ToolTaskSeamContext,
  ToolTaskSeamMeta,
  ToolTaskSeamOptions,
  TasksSupport,
  TasksWire,
} from "./mcp-client-manager/index.js";

export type {
  ConformanceResult,
  ConformanceStepId,
  OAuthConformanceAuthConfig,
  OAuthConformanceClientConfig,
  OAuthConformanceConfig,
  OAuthConformanceSuiteConfig,
  OAuthConformanceSuiteDefaults,
  OAuthConformanceSuiteFlow,
  OAuthConformanceSuiteResult,
  OAuthVerificationConfig,
  StepResult,
  VerificationResult,
} from "./oauth-conformance/index.js";
export { CONFORMANCE_CHECK_METADATA } from "./oauth-conformance/index.js";

// MCP Operations (pure functions for common MCP workflows)
export {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools,
  withEphemeralClient,
  withDisposableManager,
  listAllServerSkills,
} from "./operations.js";

export type {
  ListResourcesParams,
  ReadResourceParams,
  ListPromptsParams,
  ListPromptsMultiParams,
  GetPromptParams,
  ListToolsParams,
  WithEphemeralClientOptions,
  ListAllServerSkillsParams,
  ListAllServerSkillsResult,
} from "./operations.js";

// The versioned evaluation contract (browser-safe; also exported in full from
// `@mcpjam/sdk/contract`). Re-exported here so a code-first author can build a
// custom scorer without a second import path.
export {
  aggregateEvaluationConfigHash,
  allGatingScorersPassed,
  buildEvaluationConfigSnapshot,
  canonicalDigest,
  canonicalJson,
  definitionHash,
  errorScoreResult,
  evaluationConfigHash,
  finalizeScoreResult,
  notApplicableScoreResult,
  resolveScoreDefinition,
  scorePassed,
  sha256Hex,
  skippedScoreResult,
  PREDICATES_VERSION,
  evaluationConfigSnapshotSchema,
  resolvedScoreDefinitionSchema,
  scoreResultSchema,
} from "./contract/index.js";
export type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreRawOutcome,
  ScoreResult,
  ScoreStatus,
  ScorerContextV1,
  ScorerErrorPolicy,
  ScorerIdSource,
  ScorerRole,
} from "./contract/index.js";

// The v2 run verdict policy (browser-safe; exported in full from
// `@mcpjam/sdk/contract`). Re-exported here for the same reason as the scoring
// contract above: a code-first author reading a decision should not need a
// second import path to name its parts.
//
// CONTRACT ONLY in this wave — there is no producer behind these types yet, so
// nothing in the SDK emits an `EvalVerdictDecision`. Anything that reads one
// must check `verdictPolicyVersion === EVAL_VERDICT_POLICY_VERSION` first: a
// row without the field is a legacy percent-threshold row, NOT a v2 row.
export {
  EVAL_RATE_MEASUREMENT_STATES,
  EVAL_RUN_VERDICTS,
  EVAL_TRIAL_EXCLUSION_REASONS,
  EVAL_VERDICT_DECISION_REASONS,
  EVAL_VERDICT_POLICY_SCHEMA_ID,
  EVAL_VERDICT_POLICY_VERSION,
  evalCaseVerdictAggregationSchema,
  evalRateMeasurementSchema,
  evalRunVerdictSchema,
  evalVerdictDecisionSchema,
  isEvalRunVerdict,
  isEvalTrialExclusionReason,
  isEvalVerdictDecisionReason,
  isEvalVerdictPolicyV2,
  resolvedEvalValidityPolicySchema,
} from "./contract/index.js";
export type {
  EvalCaseVerdictAggregation,
  EvalRateMeasurement,
  EvalRateMeasurementState,
  EvalRunVerdict,
  EvalTrialExclusionReason,
  EvalTrialExclusions,
  EvalValidityCoverage,
  EvalVerdictDecision,
  EvalVerdictDecisionReason,
  EvalVerdictPolicyVersion,
  EvalVerdictValidity,
  ResolvedEvalValidityPolicy,
} from "./contract/index.js";

// The scorer runtime. Main-entry only — `judgeScorer` reaches the model
// factory, which is not browser-safe.
export {
  DEFAULT_JUDGE_THRESHOLD,
  DEFAULT_SCORER_CONCURRENCY,
  DEFAULT_SCORER_TIMEOUT_MS,
  JUDGE_TEMPLATE_VERSION,
  judgeScorer,
  predicateScorer,
  runScorers,
  scoresPassed,
} from "./scorers/index.js";
export type {
  JudgeScorerOptions,
  PredicateScorerOptions,
  Scorer,
  ScorerRunOptions,
} from "./scorers/index.js";

// The gate engine. ONE evaluator behind `assertGate` (code-first) and
// `mcpjam cloud eval gate` (hosted), so a CI gate cannot be green on one path and
// red on the other.
export {
  GATE_WAIVER_MAX_DURATION_MS,
  GATE_WAIVER_MAX_REASON_LENGTH,
  GATE_WAIVER_REASON_NOTICE,
  GateError,
  applyGateWaiver,
  assertGate,
  evaluateGates,
  formatGateReport,
  formatGateWaiverLine,
  gateInputFromPlatformRun,
  gateInputFromRunResult,
  gateInputFromSuiteResult,
  gateOutcomeVerdict,
  isGateWaiverInForce,
  passRateFractionFromPercent,
} from "./gates.js";
export { COMPARATIVE_GATE_FIELDS } from "./gates.js";
export type {
  GateInput,
  GatePolicy,
  GateReport,
  GateScore,
  GateStatus,
  GateVerdict,
  GateWaiver,
  ScoreIntegrity,
} from "./gates.js";

// Run-over-run comparison: the statistics, and the gates built on them.
// Separate from the single-run engine because the question is different —
// "did these two runs measure the same thing, and if so did it get worse?"
export { evaluateCompareGates } from "./compare-gates.js";
export type {
  CompareGateInput,
  DeterministicScoreRegression,
} from "./compare-gates.js";
export {
  DEFAULT_MIN_EFFECT_SIZE,
  DEFAULT_MIN_SAMPLE_SIZE,
  Z_95,
  assessPassRateRegression,
  detectFlakyCases,
  newcombeDifferenceInterval,
  wilsonInterval,
} from "./compare-stats.js";
export type {
  ConfidenceInterval,
  DifferenceInterval,
  FlakyCase,
  ProportionSample,
  RegressionAssessment,
  RegressionVerdict,
} from "./compare-stats.js";

// Eval matchers (browser-safe; also exported from `@mcpjam/sdk/matchers`)
export { evaluateToolCalls } from "./matchers.js";
export type {
  EvalArgumentMismatch,
  EvalMatchOptions,
  EvalOutOfOrderToolCall,
  EvalToolCall,
  EvalToolCallMatchResult,
} from "./matchers.js";

// HostConfig — the public `Host` builder (also at `@mcpjam/sdk/host-config`).
// SOURCE OF TRUTH for the host shape + canonicalizer + hash; the Convex
// backend hand-mirrors it under a golden-vector parity test. The canonicalizer
// itself is internal — `Host.toJSON()` / `Host.hash()` are the public seam.
// `McpProtocolVersion` is intentionally omitted here — already exported above.
export {
  Host,
  HostRuntime,
  isHostJson,
  snapshotHostSource,
  assertHostServersKnown,
  resolveKnownServerIds,
} from "./host-config/index.js";
export type {
  HostServerRegistry,
  HostSource,
  HostRuntimeDefaults,
  HostRuntimeManager,
} from "./host-config/index.js";
export type {
  HostInit,
  HostJson,
  HostMcp,
  HostComputer,
  HostServerOverride,
  HostConnectionDefaults,
  HostStyleId,
  Harness,
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

// MCPJam's Tasks **product policy** (`com.mcpjam/tasks`) — never a wire
// capability. Exported so the surfaces that resolve a mode can do so without
// reaching into a subpath, and so `taskModeForSurface` stays the single place
// the matrix lives.
export {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  readTasksPolicy,
  describeInvalidTasksPolicy,
  setTasksPolicy,
  clearTasksPolicy,
  taskModeForSurface,
  surfaceMayDeclareTasks,
} from "./host-config/index.js";
export type {
  TasksPolicy,
  TaskMode,
  TaskSurface,
} from "./host-config/index.js";

// Multi-round-trip (`input_required`) manual driver — MCP 2026-07-28 spec §12.
// New public exports only (API stability): the serializable stepper, the
// convenience loop, guards, error classes, and the re-exported upstream
// primitives (`isInputRequiredResult` / `withInputRequired`).
export {
  DEFAULT_MAX_MRTR_ROUNDS,
  SUPPORTED_ELICITATION_MODES,
  executeInputRequiredLeg,
  resumeInputRequiredOperation,
  runInputRequiredOperation,
  initInputRequiredState,
  makeRequestWithSchemaLegSender,
  defaultResultSchemaForMethod,
  validateInputRequests,
  validateRoundResponses,
  isMaxRoundsExceeded,
  isUnsupportedResultType,
  MrtrUndeclaredInputError,
  MrtrUnsupportedElicitationModeError,
  MrtrInputValidationError,
  isInputRequiredResult,
  withInputRequired,
} from "./mcp-client-manager/index.js";
export type {
  MrtrMethod,
  MrtrOperationState,
  MrtrLegResult,
  MrtrLegSender,
  MrtrSupportedModes,
  MrtrInputCollector,
  MrtrValidateResponse,
  ElicitationContentValidator,
  RunInputRequiredOptions,
  InputRequiredResult,
  InputRequests,
  InputResponses,
} from "./mcp-client-manager/index.js";

// Era-neutral subscription coordinator (2026-07-28 `subscriptions/listen` +
// legacy list-changed / `resources/subscribe`) — spec §13. Re-exported at the
// package root so local surfaces (the Inspector's subscription bridge) own the
// stream, and consumers outside the SDK (the CLI's listen mode) can drive it,
// without reaching into the client-manager subpath. New exports only.
export {
  SubscriptionCoordinator,
  DEFAULT_SUBSCRIPTION_RECONNECT_POLICY,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsAcknowledgedNotificationMethod,
  diffAcknowledgement,
  resolveRequestedFilter,
} from "./mcp-client-manager/index.js";
export type {
  DesiredSubscriptionInterests,
  DeliveredSubscriptionNotification,
  McpSubscriptionHandle,
  RejectedSubscriptionNotification,
  SubscriptionClientPort,
  SubscriptionCloseReason,
  SubscriptionCoordinatorOptions,
  SubscriptionFilterShape,
  SubscriptionInterestRejection,
  SubscriptionNotificationKind,
  SubscriptionReconnectPolicy,
  SubscriptionStreamRecord,
  SubscriptionStreamStatus,
} from "./mcp-client-manager/index.js";

// MCP Tasks manual-drive surface — the `input_required` driver's trust rules
// plus the creation-time status whitelist. The lifecycle engine, the `await`
// driver, and the observation adapters are already exported by the MCP Tasks
// runtime block above; this block carries only what that one does not, so a
// consumer outside the SDK (the CLI's `tasks` verbs) can drive a task to
// terminal without reaching into the client-manager subpath. New exports only.
//
// `InputRequests` / `InputResponses` (the `tasks/update` payload maps) are
// already exported by the MRTR block above and are deliberately not repeated.
// The lifecycle block above (added by the tool-task seam work) already
// re-exports the engine, the observation adapters, the driver and the shared
// task types. Only what it does NOT carry is listed here, so the two blocks
// stay a single source of truth rather than two lists to keep in step.
export {
  LEGACY_TASK_STATUSES,
  canDeclareTasksExtension,
  readDeclaredInputCapabilities,
  TaskInputRejectedError,
  DEFAULT_TASK_INPUT_LIMITS,
  createStrictElicitationContentValidator,
  retryAfterMsFromError,
} from "./mcp-client-manager/index.js";
export type {
  DriveTaskToTerminalArgs,
  DeclaredInputCapabilities,
  TaskInputDriverOptions,
  TaskInputHandlerContext,
  TaskInputHandlers,
  TaskInputRejection,
  DetailedTaskExt,
  GetTaskExtResult,
  UpdateTaskExtResult,
} from "./mcp-client-manager/index.js";

export {
  NO_TOOL_PATH_KEY,
  PATH_SEPARATOR,
  buildPathKey,
  collapseImmediateRepeats,
  toolNamesFromPathKey,
} from "./contract/tool-path.js";
