/**
 * `@mcpjam/sdk/corpus` — reference eval corpus case shape + validators.
 * Browser-safe; shared by the inspector and the `mcpjam eval` CLI so both agree
 * on the gate-eligibility rule (only `human_reviewed` cases may `--gate`).
 */

export {
  validateCorpusCase,
  validatePredicate,
  validateSuite,
  isGateEligible,
  predicateSchema,
  type ValidationResult,
} from "./validate.js";
export type {
  CorpusCase,
  ReviewStatus,
  ProvenanceSource,
  Provenance,
  TraceProvenance,
  ToolBenchProvenance,
  PrivacyReview,
  CorpusCategory,
} from "./types.js";
