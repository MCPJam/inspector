/**
 * `@mcpjam/sdk/mocks/definition`: a mock definition's types and its
 * validator, without the server that serves one. `@mcpjam/sdk/mocks` pulls in
 * the MCP server runtime, which a browser bundle must not carry.
 */

export * from "./definition-types.js";
export {
  validateMockDefinition,
  type MockIssue,
  type MockValidationResult,
} from "./validate-definition.js";
