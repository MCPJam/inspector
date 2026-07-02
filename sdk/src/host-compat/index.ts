/**
 * `@mcpjam/sdk/host-compat` — the shared host-compatibility engine.
 *
 * "Does this MCP server work on host X?" The verdict logic lives here so every
 * surface (inspector UI, `mcpjam` CLI, public API, MCP server) gathers inputs
 * (connect, list tools, read resources) and displays outputs, without
 * re-implementing a verdict. Framework-free and logo-free — facts only.
 */

export {
  deriveServerRequirements,
  type HostCompatTool,
  type HostCompatToolsInput,
} from "./server-requirements.js";
export {
  evaluateHostCompat,
  evaluateAllHosts,
  type HostCompatEvaluation,
  type EvaluateAllHostsOptions,
} from "./evaluator.js";
export {
  buildMarketHostProfiles,
  evaluateMarketHosts,
} from "./market-hosts.js";
export {
  MCP_APPS_FULL,
  MCP_APPS_CHATGPT,
  MCP_APPS_MISTRAL,
  MCP_APPS_CURSOR,
  MCP_APPS_GOOSE,
  MCP_APPS_COPILOT,
  MCP_APPS_NO_CLAIMS,
} from "./capabilities.js";
export {
  scanWidgetSource,
  scanWidgetMeta,
  type WidgetCapabilityNeed,
  type WidgetUsage,
} from "./widget-scan.js";
export {
  scanWidgetUsage,
  type ReadResourceFn,
  type ReadResourceResult,
} from "./scan-widget-usage.js";
export {
  detectHostCompatBridgeFromMeta,
  HostCompatBridge,
} from "./ui-detection.js";
export type {
  CompatVerdict,
  CompatFindingSeverity,
  CompatLane,
  CompatProvenance,
  ConnectionFacts,
  CompatFinding,
  CompatFindingCode,
  CompatLaneVerdict,
  HostCompatReport,
  ServerRequirements,
  HostCompatProfile,
} from "./types.js";
