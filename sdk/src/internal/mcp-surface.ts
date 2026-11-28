/**
 * How a platform operation appears as an MCP tool: which tools are held while
 * in beta, their annotations and their spend notice. In the SDK so every MCP
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
