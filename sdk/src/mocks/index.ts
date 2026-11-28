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
export * from "./record-store.js";
export { MOCK_SEED_MAX_RECORDS } from "./validate-state.js";
export { checkStateOutputs } from "./state-outputs.js";
export * from "./uncallable-input.js";
export { findInvalidSchemas } from "./invalid-schema.js";
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
export {
  changeEntries,
  diffMockDefinitions,
  type ChangeEntry,
  type MockChange,
  type MockChangeKind,
  type MockChangeTarget,
  type MockFieldChange,
} from "./change-list.js";
export { mockPathOf } from "./change-kinds.js";
export {
  findBindingIssues,
  type MockBindingCode,
  type MockBindingIssue,
} from "./bindings.js";
export {
  applyFieldEdit,
  editPath,
  MOCK_FAMILIES,
  type MockFamily,
  type MockFieldEdit,
  type MockFieldEditResult,
} from "./field-edit.js";
export {
  MockCursorError,
  openMockCursor,
  sealMockCursor,
  type MockCursorBinding,
  type MockCursorRefusal,
  type MockCursorState,
} from "./read-cursor.js";
export {
  MOCK_CHUNK_LIMIT,
  MOCK_READ_LIMIT,
  MOCK_TEXT_BUDGET,
  chunkText,
  fitPage,
  readMockView,
  readSelectorProblem,
  textSize,
  type MockListing,
  type MockPage,
  type MockPageHost,
  type MockReadSelector,
  type MockReadSource,
} from "./read.js";
export { isTerminalTask, TASKS_EXTENSION_ID } from "./mock-tasks.js";
export type {
  MockTaskPatch,
  MockTaskRecord,
  MockTaskStatus,
  MockTaskStore,
  MockTasks,
} from "./mock-tasks.js";
export { MODERN_REVISION } from "../server/revision.js";
export { matchTemplate, templateVariables } from "../server/uri-template.js";
export { listMockSkills } from "./mock-skills.js";
export {
  resolveMockPrompts,
  resolveMockResources,
  resolveMockTemplates,
} from "./resolve-items.js";
