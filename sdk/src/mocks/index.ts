/** `@mcpjam/sdk/mocks`: the mock server definition and what builds on it. */

export * from "./definition-caps.js";
export * from "./definition-types.js";
export * from "./validate-definition.js";
export * from "./uncallable-input.js";
export * from "./change-list.js";
export { CHANGE_PLACES, describePlace, mockPathOf } from "./change-kinds.js";
export * from "./build-mock.js";
export * from "./mock-errors.js";
export * from "./real-server.js";
export {
  planPromptGet,
  planResourceRead,
  resolveMockPrompts,
  resolveMockResources,
  resolveMockTemplates,
  type ResolvedItems,
} from "./resolve-items.js";
export { matchTemplate, templateVariables } from "./uri-template.js";
export { listMockSkills } from "./mock-skills.js";
export {
  hashRealToolListing,
  mergeTool,
  resolveMockTools,
} from "./resolve-tools.js";
export {
  inverseOfChanges,
  type InverseMock,
  type OldServer,
  type Unrestorable,
} from "./inverse.js";
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
export {
  createMockSessionMap,
  type MockSessionMap,
  type MockSessionMapOptions,
} from "./session-map.js";
export {
  createMockTaskStore,
  type MockTaskRecord,
  type MockTaskStore,
  type MockTaskStoreOptions,
} from "./mock-tasks.js";
export { chooseCase, finishCase, fillSteps } from "./saved-answers.js";
