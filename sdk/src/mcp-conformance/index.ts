export { MCPConformanceTest } from "./runner.js";
export { MCPConformanceSuite } from "./suite.js";

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

export {
  canRunConformance,
  isHttpServerConfig,
} from "./transport-support.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
} from "./transport-support.js";
