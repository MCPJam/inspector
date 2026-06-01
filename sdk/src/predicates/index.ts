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
} from "./types.js";
