/**
 * `@mcpjam/sdk/predicates` — state-based predicate library for deterministic
 * eval gating. Browser-safe (reuses the `../matchers` argument engine), shared
 * by the inspector GUI runner and the `mcpjam eval` CLI.
 */

export {
  evaluatePredicate,
  evaluatePredicates,
  allPredicatesPassed,
} from "./evaluate.js";
export { argMatch } from "./argMatcher.js";
export {
  buildIterationTranscript,
  extractFinalAssistantMessage,
  type BuildTranscriptInput,
} from "./transcript.js";
export { extractToolErrors } from "../eval-tool-execution.js";
export type {
  Predicate,
  PredicateType,
  PredicateResult,
  ArgMatcher,
  ArgMatchMode,
  IterationTranscript,
  TranscriptToolCall,
  TranscriptUsage,
  ToolErrorRecord,
  ToolErrorKind,
  CasePredicates,
  PredicatePlaceholder,
} from "./types.js";
export {
  predicateSchema,
  predicateArraySchema,
  argMatcherSchema,
  casePredicatesSchema,
  PREDICATE_PLACEHOLDER_STRINGS,
} from "./types.js";
