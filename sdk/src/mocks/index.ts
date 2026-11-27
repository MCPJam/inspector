/** `@mcpjam/sdk/mocks`: the mock server definition and what builds on it. */

export {
  MOCK_DEFINITION_CAPS,
  MOCK_DEFINITION_REF_PREFIX,
  checkDefinitionCaps,
} from "./definition-caps.js";
export type { MockCapIssue, MockCapIssueCode } from "./definition-caps.js";
export * from "./definition-types.js";
export * from "./validate-definition.js";
export * from "./output-schema.js";
export * from "./mock-errors.js";
export * from "./build-mock.js";
export * from "./real-server.js";
export * from "./mock-observer.js";
export {
  hashRealToolListing,
  mergeTool,
  resolveMockTools,
} from "./resolve-tools.js";
export {
  answerFromSaved,
  caseMatches,
  chooseCase,
  fillInputs,
  finishCase,
  jsonEqual,
} from "./saved-answers.js";
