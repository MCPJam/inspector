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
export { redactSensitiveValue } from "./redaction.js";

// Error describer — pure, browser-safe. Same module exported from the
// root entrypoint; client code MUST import from this `/browser` subpath
// to avoid pulling Node-only deps via root `@mcpjam/sdk`.
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
} from "./oauth/browser-auth.js";
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
  JWT_BEARER_GRANT,
  MCPJAM_CLIENT_URI,
  MCPJAM_LOGO_URI,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  evaluateIdJagClientMetadata,
  getBrowserDebugDynamicRegistrationMetadata,
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
export { validateClientIdMetadataUrl } from "./oauth/state-machines/shared/client-id-metadata.js";
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
} from "./xaa/constants.js";
export type { NegativeTestMode } from "./xaa/constants.js";
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
export { NEGATIVE_TEST_MODE_DETAILS } from "./xaa/negative-test-modes.js";
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
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-client-manager/mcp-protocol-version.js";

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
} from "./host-config/index.js";
