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
  type BuildTranscriptInput,
  type TurnTranscriptInput,
} from "./transcript.js";
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
