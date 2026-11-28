/**
 * How a platform operation appears as an MCP tool: which tools are held while
 * in beta, their annotations, their spend notice, and how a result or error is
 * shaped for a model. In the SDK so every MCP
 * server MCPJam ships lists catalog tools the same way. Internal: no public API
 * promise.
 */
export {
  HELD_OPERATION_NAMES,
  HELD_WHILE_IN_BETA,
} from "./mcp-surface/hold.js";
export {
  operationAnnotations,
  operationDescription,
} from "./mcp-surface/annotations.js";
export {
  clampAtWord,
  compactInsightsForModel,
  compactJourneyFindings,
  describeOperationError,
  errorStructuredContent,
  MODEL_CONTRACT_JSON_CAP,
  MODEL_EXCERPT_CAP,
  MODEL_MAX_EVIDENCE_PER_FINDING,
  MODEL_MAX_FINDINGS,
  MODEL_MAX_SESSION_IDS_PER_FINDING,
  MODEL_PHRASE_CAP,
  MODEL_TEXT_CAP,
  toolError,
  toolSuccess,
} from "./mcp-surface/results.js";
