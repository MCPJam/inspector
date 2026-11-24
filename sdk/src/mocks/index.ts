/** `@mcpjam/sdk/mocks`: the mock server definition and what builds on it. */

export * from "./definition-caps.js";
export * from "./definition-types.js";
export * from "./validate-definition.js";
export * from "./uncallable-input.js";
export * from "./change-list.js";
export * from "./build-mock.js";
export * from "./mock-errors.js";
export * from "./real-server.js";
export {
  hashRealToolListing,
  mergeTool,
  resolveMockTools,
} from "./resolve-tools.js";
export { inverseOfChanges, type InverseMock, type OldServer, type Unrestorable } from "./inverse.js";
export type {
  MockAnswerSource,
  MockObservedEvent,
  MockObserver,
} from "./mock-observer.js";
export {
  answerFromSaved,
  caseMatches,
  fillInputs,
  jsonEqual,
} from "./saved-answers.js";
export {
  MockAnswerError,
  modelAnswerPrompt,
  parseModelAnswer,
  type MockModelAnswerRequest,
  type MockModelAnswerer,
} from "./model-answers.js";
