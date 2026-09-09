/**
 * `@mcpjam/sdk/predicates` — state-based predicate library for deterministic
 * eval gating. Browser-safe (reuses the `../matchers` argument engine), shared
 * by the inspector GUI runner and the `mcpjam cloud eval` CLI.
 */

export {
  evaluatePredicate,
  evaluatePredicates,
  allPredicatesPassed,
  evaluateTurnChecks,
  finalMessageEndsWithQuestion,
  type TurnChecksInput,
} from "./evaluate.js";
export { argMatch } from "./argMatcher.js";
export {
  buildIterationTranscript,
  buildTurnTranscript,
  extractFinalAssistantMessage,
  MAX_TOOL_RESULT_TEXT_CHARS,
  MAX_TOOL_RESULT_ROWS,
  MAX_TOOL_CALL_TIMING_ROWS,
  type BuildTranscriptInput,
  type TurnTranscriptInput,
} from "./transcript.js";
export {
  validateAgainstSchema,
  type SchemaValidation,
  type SchemaViolation,
  type SchemaViolationClass,
} from "./schema-validation.js";
export { extractToolErrors } from "../eval-tool-execution.js";
export type {
  Predicate,
  PredicateType,
  PredicateResult,
  PredicateScope,
  ArgMatcher,
  ArgMatchMode,
  IterationTranscript,
  TranscriptToolCall,
  TranscriptToolResult,
  TranscriptToolResultSize,
  ToolResultSizeBasis,
  TranscriptToolCallTiming,
  TranscriptToolInventoryEntry,
  TranscriptToolAnnotations,
  TranscriptCapture,
  TranscriptCaptureState,
  TranscriptUsage,
  ToolErrorRecord,
  ToolErrorKind,
  RenderObservationStatus,
  RenderObservationSummary,
  CasePredicates,
  PredicatePlaceholder,
  CheckPolicy,
} from "./types.js";
export {
  predicateSchema,
  predicateUnion,
  predicateArraySchema,
  argMatcherSchema,
  casePredicatesSchema,
  predicateScopeSchema,
  MAX_NEEDLE_CHARS,
  MAX_SCHEMA_BYTES,
  PREDICATE_PLACEHOLDER_STRINGS,
  TURN_SCOPABLE_PREDICATE_KINDS,
  isTurnScopablePredicateKind,
  OBSERVATION_PREDICATE_KINDS,
  isObservationPredicateKind,
} from "./types.js";
export {
  CHECK_POLICY_KEYS,
  stripCheckPolicy,
  checkRole,
  checkSeverity,
  type CheckRole,
  type CheckSeverity,
} from "./policy.js";
