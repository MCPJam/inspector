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
  findListedResource,
  isListedResource,
  parseDigest,
  sha256HexOfBytes,
  sha256HexOfText,
  skillNameFromUri,
  splitSkillMarkdown,
  verifyDigest,
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
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
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
  unwrapEraNegotiationCause,
  MCPTasksWireError,
  isMCPTasksWireError,
} from "./mcp-client-manager/index.js";
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
export { redactSensitiveValue } from "./redaction.js";
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
  summarizeStructuredCases,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
} from "./structured-reporting.js";
export type {
  StructuredCaseClassification,
  StructuredCaseResult,
  StructuredSummaryBucket,
  StructuredRunSummary,
  StructuredRunReport,
} from "./structured-reporting.js";
export {
  toConformanceReport,
  renderConformanceReportJson,
  renderConformanceReportJUnitXml,
} from "./conformance-reporting.js";
export type {
  ConformanceReport,
  ConformanceReportCase,
  ConformanceReportCaseStatus,
  ConformanceReportGroup,
  ConformanceReportKind,
  SupportedConformanceResult,
} from "./conformance-reporting.js";
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
export { runOAuthLogin } from "./oauth-login.js";
export type {
  OAuthLoginConfig,
  OAuthLoginDependencies,
  OAuthLoginResult,
} from "./oauth-login.js";
// Loopback authorization-code capture + PKCE primitives, reused by the CLI's
// platform login (`mcpjam login`) in addition to OAuth conformance runs.
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
  ERROR_CATALOG,
  extractNodeErrno,
  RETRYABLE_NODE_ERROR_CODES,
} from "./error-describer/index.js";
export type {
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
