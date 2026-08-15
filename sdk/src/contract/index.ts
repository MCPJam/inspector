/**
 * `@mcpjam/sdk/contract` — the versioned evaluation contract.
 *
 * This module is browser-safe and intentionally has no node-only deps so it
 * can be imported into client bundles (same convention as `../matchers.ts`).
 * It is data + pure derivation only: no model calls, no network, no `process`.
 * The scorer runtime that actually calls a judge lives in the main entry.
 *
 * One shape for every eval surface — SDK code-first runs, hosted runs, PR
 * checks, schedules — so a verdict means the same thing wherever it was
 * produced:
 *
 *   - {@link ScoreDefinition} / {@link ResolvedScoreDefinition} — what a scorer
 *     is and whether it gates.
 *   - {@link ScoreResult} — one scorer's verdict for one iteration.
 *   - {@link EvaluationConfigSnapshot} — the join table between them, hashed.
 *
 * The hashing is pinned cross-runtime (canonical JSON + SHA-256 over RESOLVED
 * definitions) because four runtimes that share no code must agree on it, and
 * the backend re-derives it to verify score integrity at ingest.
 */

export type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreRawOutcome,
  ScoreResult,
  ScoreStatus,
  ScorerContextV1,
  ScorerErrorPolicy,
  ScorerIdSource,
  ScorerRole,
} from "./types.js";

export {
  MAX_ERROR_LENGTH,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_SCORER_ID_LENGTH,
  PREDICATES_VERSION,
} from "./types.js";

export {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  sha256Hex,
} from "./canonical.js";

export {
  evaluationConfigSnapshotSchema,
  resolvedScoreDefinitionSchema,
  scoreDefinitionSchema,
  scoreResultArraySchema,
  scoreResultSchema,
  scoreStatusSchema,
  scorerErrorPolicySchema,
  scorerIdSourceSchema,
  scorerRoleSchema,
} from "./schemas.js";

export {
  aggregateEvaluationConfigHash,
  buildEvaluationConfigSnapshot,
  definitionHash,
  errorScoreResult,
  evaluationConfigHash,
  finalizeScoreResult,
  notApplicableScoreResult,
  resolveScoreDefinition,
  scorePassed,
  skippedScoreResult,
} from "./derive.js";

export {
  LEGACY_TEST_SCORER_ID,
  LEGACY_TEST_VERSION,
  TOOL_MATCH_SCORER_ID,
  TOOL_MATCH_VERSION,
  fromCriterionResult,
  fromGoalCompletionCase,
  fromLegacyTestOutcome,
  fromToolMatchResult,
  generatedPredicateScorerId,
  legacyTestScoreDefinition,
  predicateScoreDefinition,
  scoreResultFromPredicateResult,
  toolMatchScoreDefinition,
} from "./adapters.js";
