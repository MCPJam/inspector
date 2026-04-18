export { MCPConformanceTest } from "./runner.js";
export { MCPConformanceSuite } from "./suite.js";

export type {
  MCPCheckCategory,
  MCPCheckId,
  MCPCheckResult,
  MCPCheckStatus,
  MCPConformanceConfig,
  MCPConformanceResult,
  MCPConformanceSuiteConfig,
  MCPConformanceSuiteResult,
} from "./types.js";

export {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
} from "./types.js";

export {
  canRunConformance,
  isHttpServerConfig,
} from "./transport-support.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
} from "./transport-support.js";
