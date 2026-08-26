/**
 * MCPClientManager module - Public API exports
 *
 * @packageDocumentation
 */

// Main class
export { MCPClientManager } from "./MCPClientManager.js";

// Types - Server configuration
export type {
  MCPServerConfig,
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  StdioServerConfig,
  HttpServerConfig,
  BaseServerConfig,
  UnauthorizedRefreshHandler,
  UnauthorizedRefreshResult,
} from "./types.js";

// Types - State and status
export type {
  MCPConnectionStatus,
  ServerSummary,
  ManagedClientState,
  RegisteredServerState,
  LiveClientState,
} from "./types.js";
export type { MCPServerReplayConfig } from "../eval-reporting-types.js";

// Types - Handlers and callbacks
export type {
  ElicitationHandler,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitationMode,
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
} from "./types.js";
export type { DeclaredElicitationCapability } from "./elicitation.js";
export { DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS } from "./constants.js";

// Types - Tool execution
export type {
  ExecuteToolArguments,
  TaskOptions,
  ExecuteToolRequest,
} from "./types.js";

// Types - Request options
export type {
  ClientRequestOptions,
  CallToolOptions,
  ClientCapabilityOptions,
} from "./types.js";

// Types - Response cache (SEP-2549) provenance
export type {
  CacheMode,
  CacheScope,
  CacheHitEvent,
  CacheEventLogger,
} from "./types.js";
// Phase 5 auto-negotiation-activation telemetry (new exports only).
export type {
  NegotiationOutcomeEvent,
  NegotiationOutcomeLogger,
  ConfiguredNegotiationMode,
} from "./types.js";
export {
  ObservableResponseCache,
  type ObservableResponseCacheOptions,
} from "./observable-response-cache.js";

// Types - MCP result aliases
export type {
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
  MCPServerSummary,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
  ListToolsResult,
} from "./types.js";

// Types - Executable tools
export type { Tool, ToolExecuteOptions, AiSdkTool } from "./types.js";

// Tool converters
export {
  convertMCPToolsToVercelTools,
  ensureJsonSchemaObject,
  isChatGPTAppTool,
  isMcpAppTool,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
  type ToolSchemaOverrides,
  type ConvertedToolSet,
  type CallToolExecutor,
} from "./tool-converters.js";
export {
  MCP_DIRECT_IMAGE_MAX_BYTES,
  MCP_IMAGE_MAX_MEDIA_PARTS,
  MCP_IMAGE_MAX_TOTAL_BYTES,
  MCP_LINKED_RESOURCE_MAX_READS,
  MCP_PRESERVE_RAW_RESULT_FOR_UI,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
  type McpModelOutputOptions,
  type McpModelOutputWithLinkedResourcesOptions,
  type McpModelVisibleToolResultPolicy,
  type McpLinkedResourceReader,
} from "./model-output.js";

// Utility functions (useful for testing and advanced use cases)
export { buildRequestInit } from "./transport-utils.js";
export { isMethodUnavailableError, formatError } from "./error-utils.js";
export {
  applyRuntimeClientCapabilities,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
  withSkillsExtensionCapability,
} from "./capabilities.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isUnauthorized401,
  isInsufficientScopeError,
  extractInsufficientScopeChallenge,
  isMCPAuthError,
  unwrapEraNegotiationCause,
  classifyNegotiationFailureClass,
  MCPTasksWireError,
  isMCPTasksWireError,
} from "./errors.js";
export type { InsufficientScopeChallenge } from "./errors.js";

export type { RetryPolicy } from "../retry.js";
export {
  DEFAULT_RETRY_POLICY,
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryWithPolicy,
} from "../retry.js";

// Task utilities
export {
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
} from "./tasks.js";
export {
  MCP_TASKS_EXTENSION_ID,
  resolveTasksWire,
  serverDeclaresTasksExtension,
} from "./tasks-dispatch.js";
export { resolveTasksSupport } from "./tasks-dispatch.js";
export type { TasksWire, TasksSupport } from "./tasks-dispatch.js";

// io.modelcontextprotocol/tasks (SEP-2663) extension wire.
export {
  CLIENT_CAPABILITIES_META_KEY,
  TasksExtGetMethod,
  TasksExtUpdateMethod,
  TasksExtCancelMethod,
  TasksExtNotificationMethod,
  buildTasksExtensionRequestMeta,
  withTasksExtensionDeclaration,
  getTaskExt,
  updateTaskExt,
  cancelTaskExt,
  canOpenTaskDeclaredListen,
  openTaskDeclaredListen,
} from "./tasks-ext.js";
export type {
  TaskExt,
  TaskExtStatus,
  TaskExtError,
  DetailedTaskExt,
  WorkingTaskExt,
  InputRequiredTaskExt,
  CompletedTaskExt,
  FailedTaskExt,
  CancelledTaskExt,
  CreateTaskExtResult,
  GetTaskExtResult,
  UpdateTaskExtResult,
  CancelTaskExtResult,
  TaskExtNotificationParams,
  TaskExtResultType,
} from "./tasks-ext-types.js";
export { TERMINAL_TASK_EXT_STATUSES } from "./tasks-ext-types.js";
export {
  InvalidTaskExtPayloadError,
  isInvalidTaskExtPayloadError,
  isCreateTaskExtResult,
  assertCreateTaskExtResult,
  assertGetTaskExtResult,
  assertDetailedTaskExt,
  assertTaskExtAck,
  parseTaskExtNotificationParams,
  assertTaskExtNotificationParams,
} from "./tasks-ext-guards.js";

// io.modelcontextprotocol/skills (SEP-2640) extension wire.
export {
  MCP_SKILLS_EXTENSION_ID,
  clientDeclaresSkillsExtension,
  resolveSkillsSupport,
  serverDeclaresSkillsExtension,
  skillsDirectoryReadEnabled,
} from "./skills-dispatch.js";
export type { SkillsSupport } from "./skills-dispatch.js";
export {
  SkillsExtListMethod,
  SkillsExtGetMethod,
  SkillsExtDirectoryReadMethod,
  SkillsExtRequestMethods,
  SKILL_NOT_FOUND_ERROR_CODE,
  getSkillExt,
  isSkillNotFoundError,
  listSkillsExt,
  readResourceDirectoryExt,
} from "./skills-ext.js";
export type {
  SkillEntry,
  SkillResourceRef,
  SkillsExtListResult,
  SkillsDirectoryEntry,
  SkillsDirectoryReadResult,
  SkillIdentityFrontmatter,
} from "./skills-ext-types.js";
export { INODE_DIRECTORY_MIME_TYPE } from "./skills-ext-types.js";
export {
  InvalidSkillsPayloadError,
  isInvalidSkillsPayloadError,
  MCPSkillsWireError,
  isMCPSkillsWireError,
  assertSkillsListResult,
  assertSkillEntry,
  assertSkillsGetResult,
  assertDirectoryReadResult,
} from "./skills-ext-guards.js";
export {
  SkillIntegrityError,
  isSkillIntegrityError,
  canonicalJson,
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
} from "./skills-integrity.js";
export type {
  DigestVerification,
  FrontmatterIdentityCheck,
  ParsedDigest,
  SupportedDigestAlgorithm,
} from "./skills-integrity.js";

// Shared task lifecycle engine — per-task due-time scheduling, dynamic
// TTL/poll interval, backoff, durable input-key state. Every Tasks surface
// drives this instead of writing its own polling loop.
export {
  TaskLifecycleEngine,
  taskLifecycleKey,
  isTerminalLifecycleStatus,
  toSnapshot as toTaskLifecycleSnapshot,
  TERMINAL_LIFECYCLE_STATUSES,
} from "./task-lifecycle.js";
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
} from "./task-lifecycle.js";
export {
  extensionTaskToObservation,
  legacyTaskToObservation,
  LEGACY_TASK_STATUSES,
  isUnknownTaskError,
  isTasksDeclarationRequiredError,
  parseRetryAfterMs,
  retryAfterMsFromError,
  UNKNOWN_TASK_ERROR_CODE,
  TASKS_DECLARATION_REQUIRED_ERROR_CODE,
} from "./task-lifecycle-adapters.js";
// Node-only (Ajv compiles via `new Function`); not re-exported from browser.
export { createStrictElicitationContentValidator } from "./elicitation-content-validator.js";

// `input_required` driver — routes a task's embedded elicitation / roots /
// sampling requests through the SAME trust rules as the standalone path.
export {
  TASK_INPUT_METHODS,
  isTaskInputMethod,
  TaskInputRejectedError,
  collectTaskInputResponses,
  canDeclareTasksExtension,
  readDeclaredInputCapabilities,
  DEFAULT_TASK_INPUT_LIMITS,
} from "./task-input-driver.js";

// The single task-creation fan-out point (durable tracking, hosted stream,
// best-effort registry, analytics) and the bounded `await`-mode driver used
// by automation surfaces.
export { TaskCreatedSink } from "./task-created-event.js";
export type {
  TaskCreatedConsumer,
  TaskCreatedConsumerFailure,
  TaskCreatedDispatchResult,
  TaskCreatedEvent,
  TaskCreationSurface,
} from "./task-created-event.js";
export { driveTaskToTerminal } from "./task-await-driver.js";
export type {
  DriveTaskToTerminalArgs,
  TaskAwaitOutcome,
  TaskAwaitResult,
} from "./task-await-driver.js";

// The one place a model-facing tool call may become a task.
export {
  runToolTaskSeam,
  toolTaskSeamOptionsFor,
  TASK_SEAM_META_KEY,
} from "./tool-task-seam.js";
export type {
  ToolTaskAwaitOptions,
  ToolTaskSeamContext,
  ToolTaskSeamMeta,
  ToolTaskSeamOptions,
} from "./tool-task-seam.js";
export type {
  CollectTaskInputResult,
  DeclaredInputCapabilities,
  TaskInputHandlerContext,
  TaskInputHandlers,
  TaskInputKeyOutcome,
  TaskInputLimits,
  TaskInputMethod,
  TaskInputDriverOptions,
  TaskInputRejection,
  TaskInputRejectionReason,
} from "./task-input-driver.js";
export {
  TASK_EXT_INPUT_REQUEST_METHODS,
  isRecognizedInputRequestMethod,
  describeTaskExtInputRequests,
} from "./tasks-ext-schemas.js";
export type { TaskExtInputRequestMethod } from "./tasks-ext-schemas.js";
export {
  TASK_CREATED_META_KEY,
  wrapFetchForTaskRouting,
  wrapTransportForTaskResults,
  wrapTransportForFirstPageOnly,
  stripNextCursorFromListResult,
} from "./transport-utils.js";
export {
  wrapFetchForHttpLogging,
  deriveMirroredBodyValues,
} from "./http-exchange-log.js";
export type {
  HttpExchangeLogEvent,
  HttpExchangeLogger,
} from "./http-exchange-log.js";

// Notification schemas (for advanced use cases)
export {
  ResourceListChangedNotificationMethod,
  ResourceUpdatedNotificationMethod,
  PromptListChangedNotificationMethod,
  LoggingMessageNotificationMethod,
} from "./notification-handlers.js";

// ManagedMcpClient: interface + adapters + factory for 2026-07-28
// stateless preview. The manager types its client state as
// `ManagedMcpClient` (PR3); SDK consumers that need the underlying
// upstream `Client` keep using `getClient()`, while new consumers can
// use `getManagedClient()` for either adapter.
export type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";
export {
  NotYetSupportedInStateless,
  StatelessRequiresHttpTransport,
  PaginatedToolHeaderDiscoveryUnsupported,
  ProtocolVersionPinUnsupported,
} from "./managed-mcp-client.js";
export { OfficialSdkClientAdapter } from "./official-sdk-client-adapter.js";
export {
  LogLevelMetaClient,
  type LogLevelProvider,
} from "./log-level-meta-client.js";
// OpenTelemetry trace-context propagation over the 2026-07-28 reserved
// `_meta` keys. Propagation only: with no provider wired, nothing is emitted.
export {
  TraceContextMetaClient,
  type ConnectionTraceContextProvider,
} from "./trace-context-meta-client.js";
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
  type ParsedTraceparent,
  type TraceContext,
  type TraceContextProvider,
} from "./trace-context.js";
export {
  DialectAwareJsonSchemaValidator,
  type DialectAwareJsonSchemaValidatorOptions,
} from "./dialect-aware-json-schema-validator.js";
export { CspSafeDialectAwareJsonSchemaValidator } from "./csp-safe-dialect-aware-json-schema-validator.js";
export {
  createManagedMcpClient,
  wrapLegacyClient,
  type CreateManagedMcpClientArgs,
  type McpProtocolVersion,
} from "./managed-mcp-client-factory.js";
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  protocolVersionLabel,
} from "./mcp-protocol-version.js";

// Era-neutral subscription coordinator (2026-07-28 `subscriptions/listen`
// + legacy list-changed/`resources/subscribe`). New exports only.
export {
  SubscriptionCoordinator,
  DEFAULT_SUBSCRIPTION_RECONNECT_POLICY,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsAcknowledgedNotificationMethod,
  ToolListChangedNotificationMethod,
  TasksNotificationMethod,
  diffAcknowledgement,
  resolveRequestedFilter,
} from "./subscription-coordinator.js";
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
} from "./subscription-coordinator.js";

// Multi-round-trip (`input_required`) manual driver — spec §12 (new exports).
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
} from "./mrtr-driver.js";
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
} from "./mrtr-driver.js";

// SEP-2243 `x-mcp-header` → `Mcp-Param-*` mirroring. Exported because three
// surfaces outside the manager need the SAME scan the send path uses: the
// conformance runner (`tools-x-mcp-header-declarations-valid` judges each
// tool's declarations), the CLI (which prints what it mirrored), and the
// Tracing panel's `Mcp-Param-*` verdicts. A second copy of the walk would be
// a second answer to "is this tool definition valid".
export {
  buildMcpParamHeaders,
  classifyMcpHeader,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  scanXMcpHeaderDeclarations,
  stripXMcpHeaderAnnotations,
} from "./mcp-header-mirror.js";
export type {
  McpParamCrossCheck,
  XMcpHeaderDeclaration,
  XMcpHeaderScan,
} from "./mcp-header-mirror.js";
