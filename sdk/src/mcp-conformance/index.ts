export { MCPConformanceTest } from "./runner.js";
export { MCPConformanceSuite } from "./suite.js";

export type {
  MCPCheckCategory,
  MCPConformanceFixtures,
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
} from "./types.js";

export {
  CHECK_ERAS,
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSION_ERA_IDS,
  MCP_READINESS_IDS,
  PROTOCOL_VERSION_ERAS,
} from "./types.js";

// §15.5: the ONE raw capture / SSE-parsing primitive, now owned by production
// conformance code instead of test support.
export {
  createCapturingFetch,
  getWireField,
  hasWireField,
  parseSseEvents,
  redactHeadersForLog,
} from "./raw-capture.js";
export type {
  CapturingFetch,
  FetchLike,
  RawExchange,
  RawRequest,
  RawResponse,
  RawSseEvent,
} from "./raw-capture.js";

// §15.3 subscription MUSTs: the bounded, incremental `subscriptions/listen`
// observation seam. Separate from the buffering raw-HTTP harness on purpose —
// that one reads a response to completion and so cannot hold a stream open.
export {
  filterRequests,
  isSubscriptionNotificationMethod,
  observeListenStream,
  subscriptionTagOf,
  LISTEN_IDLE_WINDOW_MS,
  LISTEN_METHOD,
  LISTEN_OBSERVATION_WINDOW_MS,
  SUBSCRIPTION_ACK_METHOD,
  SUBSCRIPTION_NOTIFICATION_FILTER_KEYS,
} from "./raw-listen.js";
export type {
  ListenObservation,
  ListenObservationOptions,
  ListenObservationOutcome,
  SubscriptionFilterWire,
  SubscriptionNotificationMethod,
} from "./raw-listen.js";

// The run-wide wire record and the schema validator that reads it. Node-only:
// Ajv compiles with `new Function`, so neither is exported from the browser
// entry (see `wire-schema.ts` for the full reasoning).
export { WireObservationRecorder } from "./wire-observations.js";
export type {
  ObservedRequestId,
  ObservedWireMessage,
} from "./wire-observations.js";
export { WireSchemaValidator, TASKS_EXTENSION_ID } from "./wire-schema.js";
export type {
  WireSchemaValidationReport,
  WireSchemaViolation,
} from "./wire-schema.js";
export {
  CORE_WIRE_SCHEMAS,
  EXTENSION_SCHEMA_REVISIONS,
  EXTENSION_WIRE_SCHEMAS,
} from "./schemas/index.js";
export type { WireSchemaDocument } from "./schemas/index.js";

export {
  canRunConformance,
  isHttpServerConfig,
} from "./transport-support.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
} from "./transport-support.js";
