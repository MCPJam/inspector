/**
 * Browser-safe SDK entrypoint.
 *
 * This subpath must stay free of Node-only runtime imports.
 */

export {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
} from "./mcp-client-manager/capabilities.js";
export { redactSensitiveValue } from "./redaction.js";

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
  MCPJAM_CLIENT_URI,
  MCPJAM_LOGO_URI,
  getBrowserDebugDynamicRegistrationMetadata,
} from "./oauth/client-identity.js";
export { buildOAuthSequenceActions } from "./oauth/sequence-actions.js";
export {
  createOAuthStateMachine,
  PROTOCOL_VERSION_INFO,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
} from "./oauth/state-machines/factory.js";
export {
  getStepInfo,
  getStepIndex,
} from "./oauth/state-machines/shared/step-metadata.js";
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
