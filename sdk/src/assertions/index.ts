/**
 * `@mcpjam/sdk/assertions` — the deterministic rule library under its canonical
 * name.
 *
 * A barrel, not a move. The implementation stays in `../predicates/`, and
 * `@mcpjam/sdk/predicates` keeps working: the two subpaths are one library with
 * two spellings for the length of the rollout.
 *
 * IDENTICAL IN SOURCE, NOT IN THE PUBLISHED BUNDLE. Imported from source (the
 * inspector's aliases, this package's tests) both subpaths are the same module
 * objects. The built package is different: `tsup.config.ts` sets
 * `splitting: false`, so `dist/assertions/index.js` and
 * `dist/predicates/index.js` each inline their own copy. A consumer of the
 * published package gets equal behaviour but separate function and schema
 * instances, so `evaluateAssertions === evaluatePredicates` is false there, and
 * so is any identity or `instanceof` check across the two subpaths. Import one
 * subpath per consumer.
 *
 * Moving the files instead would have been a larger diff for no benefit and one
 * real cost: `mcpjam-inspector`'s vitest configs and its Vite build alias each
 * SDK subpath to source by explicit list, so a relocated module is a build that
 * resolves published `dist` in some suites and source in others.
 */

export {
  // Evaluation
  evaluatePredicate as evaluateAssertion,
  evaluatePredicates as evaluateAssertions,
  allPredicatesPassed as allAssertionsPassed,
  evaluateTurnChecks,
  finalMessageEndsWithQuestion,
  // Matching
  argMatch,
  // Transcripts
  buildIterationTranscript,
  buildTurnTranscript,
  extractFinalAssistantMessage,
  MAX_TOOL_RESULT_TEXT_CHARS,
  MAX_TOOL_RESULT_ROWS,
  MAX_TOOL_CALL_TIMING_ROWS,
  // Schema validation
  validateAgainstSchema,
  // Tool errors
  extractToolErrors,
  // Schemas
  predicateSchema as assertionSchema,
  predicateUnion as assertionUnion,
  predicateArraySchema as assertionArraySchema,
  argMatcherSchema,
  casePredicatesSchema as caseAssertionsSchema,
  predicateScopeSchema as assertionScopeSchema,
  MAX_NEEDLE_CHARS,
  MAX_SCHEMA_BYTES,
  PREDICATE_PLACEHOLDER_STRINGS as ASSERTION_PLACEHOLDER_STRINGS,
  TURN_SCOPABLE_PREDICATE_KINDS as TURN_SCOPABLE_ASSERTION_KINDS,
  isTurnScopablePredicateKind as isTurnScopableAssertionKind,
  OBSERVATION_PREDICATE_KINDS as OBSERVATION_ASSERTION_KINDS,
  isObservationPredicateKind as isObservationAssertionKind,
  // Policy
  CHECK_POLICY_KEYS as ASSERTION_POLICY_KEYS,
  stripCheckPolicy as stripAssertionPolicy,
  checkRole as assertionRole,
  checkSeverity as assertionSeverity,
} from "../predicates/index.js";

export type {
  Predicate as Assertion,
  PredicateType as AssertionType,
  PredicateResult as AssertionResult,
  PredicateScope as AssertionScope,
  CasePredicates as CaseAssertions,
  CheckPolicy as AssertionPolicy,
  CheckRole as AssertionRole,
  CheckSeverity as AssertionSeverity,
  PredicatePlaceholder as AssertionPlaceholder,
  // Transcript shapes keep their names — they describe evidence, not rules.
  ArgMatcher,
  ArgMatchMode,
  BuildTranscriptInput,
  IterationTranscript,
  RenderObservationStatus,
  RenderObservationSummary,
  SchemaValidation,
  SchemaViolation,
  SchemaViolationClass,
  ToolErrorKind,
  ToolErrorRecord,
  ToolResultSizeBasis,
  TranscriptCapture,
  TranscriptCaptureState,
  TranscriptToolAnnotations,
  TranscriptToolCall,
  TranscriptToolCallTiming,
  TranscriptToolInventoryEntry,
  TranscriptToolResult,
  TranscriptToolResultSize,
  TranscriptUsage,
  TurnChecksInput,
  TurnTranscriptInput,
} from "../predicates/index.js";

/**
 * `requiresRenderObservations` asks a question about EVIDENCE, not about
 * vocabulary, so it keeps its name on both subpaths.
 */
export {
  RENDER_OBSERVATION_PREDICATE_KINDS as RENDER_OBSERVATION_ASSERTION_KINDS,
  requiresRenderObservations,
} from "../predicates/types.js";
