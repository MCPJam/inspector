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
 *
 * Alongside the score contract, this entry point is the canonical home of the
 * shapes every eval surface authors against:
 *
 *   - {@link testStepSchema} — the authored step union (relocated here from the
 *     inspector's `shared/steps.ts`, which now re-exports it, so there is one
 *     definition rather than a copy per repo).
 *   - {@link evalSuiteFileSchema} — the versioned suite FILE, plus its
 *     generated JSON Schema ({@link evalSuiteFileJsonSchema}).
 *   - {@link opaqueIdSchema} / {@link mintCaseId} — declared, opaque identity.
 *   - {@link USER_VALUE_STAGES} and the other chain enums — the shared
 *     vocabulary the reporting and import surfaces mirror.
 *   - {@link deriveStageResults} — the pure, versioned derivation that turns
 *     one iteration's authored case plus captured evidence into those stages'
 *     states, and {@link stageDerivationSchema}, the validator every write
 *     boundary checks a reported derivation against.
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
  allGatingScorersPassed,
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

// ── identity ─────────────────────────────────────────────────────────────────
export type { OpaqueId } from "./identity.js";
export {
  CASE_ID_PREFIX,
  MAX_OPAQUE_ID_LENGTH,
  MINTED_ID_ENTROPY_CHARS,
  SUITE_ID_PREFIX,
  isOpaqueId,
  mintCaseId,
  mintSuiteId,
  opaqueIdSchema,
} from "./identity.js";

// ── the user-value chain vocabulary ──────────────────────────────────────────
export type {
  FailureCategory,
  ImportMappingStatus,
  IterationStatus,
  StageState,
  UserValueStage,
} from "./chain.js";
export {
  FAILURE_CATEGORIES,
  IMPORT_MAPPING_STATUSES,
  ITERATION_STATUSES,
  STAGE_STATES,
  USER_VALUE_STAGES,
  failureCategorySchema,
  importMappingStatusSchema,
  iterationStatusSchema,
  stageStateSchema,
  userValueStageSchema,
} from "./chain.js";

// ── deriving a stage's state from a run ──────────────────────────────────────
export type {
  StageAuthoredCase,
  StageDerivation,
  StageDerivationInput,
  StageEvidence,
  StageEvidenceRefs,
  StagePredicateResultLike,
  StagePromptSummaryLike,
  StageReason,
  StageRenderObservationLike,
  StageResultRow,
  StageSetupPhaseSignal,
  StageSetupSignals,
  StageSpanLike,
  StageStepErrorLike,
  StageToolErrorLike,
} from "./stage-derivation.js";
export {
  MAX_EVIDENCE_REASONS,
  MAX_EVIDENCE_REASON_CHARS,
  STAGE_ANALYZER_VERSION,
  STAGE_METADATA_KEYS,
  STAGE_REASONS,
  deriveStageResults,
  isPositiveToolCallPredicateKind,
  isSelectionPredicateKind,
  stageDerivationSchema,
  stageDerivationToMetadata,
  stageReasonSchema,
  stageResultRowSchema,
} from "./stage-derivation.js";

// ── stage analytics (D5) ─────────────────────────────────────────────────────
/**
 * Contract and runtime wiring for the D5/B5 eval analytics fields.
 *
 * B5c now carries `intent` through authoring, suite-file sync, Platform
 * mappings, and Inspector reporting, and derives `StageMeasurementsV1` while
 * spans are still available. The backend storage/ingest deployment must be
 * present before a released client publishes these fields to production.
 *
 * This sequencing is deliberate: a client must never accept a nonempty intent
 * or measurement payload and silently drop it. The backend contract was frozen
 * in B5a and deployed before enabling these runtime write paths.
 */
export type {
  CaseIntent,
  CaseIntentUpdate,
  IntentUpdateResolution,
} from "./stage-intent.js";
export {
  INTENT_EXCLUDED_FROM_SEMANTIC_EXACTNESS,
  MAX_INTENT_CHARS,
  UNLABELED_INTENT_LABEL,
  caseIntentSchema,
  caseIntentUpdateSchema,
  intentFingerprintValue,
  intentSliceKey,
  normalizeIntent,
  resolveIntentUpdate,
} from "./stage-intent.js";

export type {
  MeasurementSpanLike,
  StageLatencySample,
  StageMeasurementInput,
  StageMeasurementRow,
  StageMeasurementsSchemaVersion,
  StageMeasurementsV1,
  StageReach,
} from "./stage-measurements.js";
export {
  LATENCY_BASIS_EVIDENCE_SPAN_UNION,
  LATENCY_BASIS_SETUP_PHASE_WALL,
  LATENCY_UNIT,
  STAGE_LATENCY_ELIGIBLE_STAGES,
  STAGE_MEASUREMENTS_METADATA_KEY,
  STAGE_MEASUREMENTS_SCHEMA_VERSION,
  STAGE_REACH_STATES,
  attachStageMeasurements,
  deriveStageMeasurements,
  reachForStageState,
  reachIsConsistentWithState,
  stageLatencySampleSchema,
  stageMayCarryLatency,
  stageMeasurementDisagreements,
  stageMeasurementRowSchema,
  stageMeasurementsSchema,
  stageMeasurementsStructuralSchema,
  stageReachSchema,
  unionDurationMs,
} from "./stage-measurements.js";

export type {
  EvalSetupTally,
  EvalStageAnalyticsMaterializationState,
  EvalStageAnalyticsSchemaVersion,
  EvalStageAnalyticsSlice,
  EvalStageAnalyticsSliceRow,
  EvalStageAnalyticsV1,
  EvalStageCoverageDetail,
  EvalStageExclusionClass,
  EvalStageExclusions,
  EvalStageLatencyAggregate,
  EvalStageParityBlocker,
  EvalStageRate,
  EvalStageTally,
  EvalSetupLatencyAggregate,
  SetupPhase,
} from "./stage-analytics.js";
export {
  EVAL_STAGE_ANALYTICS_MATERIALIZATION_STATES,
  EVAL_STAGE_ANALYTICS_SCHEMA_ID,
  EVAL_STAGE_ANALYTICS_SCHEMA_VERSION,
  EVAL_STAGE_EXCLUSION_CLASSES,
  EVAL_STAGE_PARITY_BLOCKERS,
  MAX_ANALYTICS_SLICES,
  MAX_HOST_SLICES,
  MAX_INTENT_SLICES,
  MAX_MODEL_SLICES,
  SETUP_PHASES,
  STAGE_TALLIES_PER_SLICE,
  evalSetupLatencyAggregateSchema,
  evalSetupTallySchema,
  evalStageAnalyticsMaterializationStateSchema,
  evalStageAnalyticsSchema,
  evalStageAnalyticsSliceRowSchema,
  evalStageAnalyticsSliceSchema,
  evalStageAnalyticsStructuralSchema,
  evalStageCoverageDetailSchema,
  evalStageExclusionsSchema,
  evalStageLatencyAggregateSchema,
  evalStageRateSchema,
  evalStageTallySchema,
  isServerAttributedSetupFailure,
  latencyMeanMs,
  measuredPassRate,
  measurementCoverageRate,
  reachRate,
  stageAnalyticsParityBlockers,
  stageRate,
} from "./stage-analytics.js";

export type {
  StageAnalyticsInput,
  StageAnalyticsRunInput,
  StageAnalyticsSetupSignalInput,
  StageAnalyticsTrialInput,
  TrialClassification,
} from "./stage-analytics-aggregate.js";
export {
  aggregateStageAnalytics,
  classifyStageAnalyticsTrial,
} from "./stage-analytics-aggregate.js";

// ── the chat-session evidence adapter (D8) ───────────────────────────────────
//
// NOT a second derivation: it normalizes one chat session's evidence into the
// SAME `deriveStageResults` input every eval iteration goes through. User
// Testing, swarm, and (post-D8p) direct/playground sessions all pass through
// here, so "the connection worked" means one thing on every surface.
export type {
  ChatSessionCriteriaEvidence,
  ChatSessionCriterionOutcome,
  ChatSessionGoalJudgeEvidence,
  ChatSessionLifecycle,
  ChatSessionReadinessEvidence,
  ChatSessionStageInput,
  ChatSessionStageSource,
} from "./chat-session-stage-adapter.js";
export {
  CHAT_SESSION_STAGE_SOURCES,
  buildChatSessionAuthoredCase,
  buildChatSessionStageInput,
} from "./chat-session-stage-adapter.js";

// ── the authored step union ──────────────────────────────────────────────────
export type {
  AssertStep,
  ElementLocator,
  InteractAction,
  InteractStep,
  PromptStep,
  StepAssertionPayload,
  TestStep,
  TestStepKind,
  ToolCallStep,
  WidgetAssertion,
} from "./steps.js";
export {
  MAX_PROBE_ARGS_CHARS,
  MAX_PROBE_RENDER_TIMEOUT_MS,
  MAX_SCRIPTED_STEP_TEXT_CHARS,
  MAX_SCRIPTED_WAIT_MS,
  MAX_TEST_STEPS,
  TEST_STEP_KINDS,
  assertStepSchema,
  elementLocatorSchema,
  interactActionSchema,
  interactStepSchema,
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  promptStepSchema,
  stepAssertionPayloadSchema,
  stepsSchema,
  testStepSchema,
  toolCallStepSchema,
  widgetAssertionSchema,
} from "./steps.js";

// ── the suite file ───────────────────────────────────────────────────────────
export type {
  EvalSuiteFile,
  EvalSuiteFileCase,
  EvalSuiteFileCaseImport,
  EvalSuiteFileDefaults,
  EvalSuiteFileHost,
  EvalSuiteFileProvenance,
  EvalSuiteFileServer,
  EvalSuiteFileTarget,
  EvalSuiteFileToolPolicy,
  EvalSuiteFileValidity,
} from "./suite-file.js";
export type {
  ToolPolicyDecision,
  ToolPolicyDecisionReason,
  ToolPolicySnapshot,
  ToolSafetyClassification,
} from "./tool-policy.js";
export {
  TOOL_POLICY_DECISION_REASONS,
  buildToolPolicySnapshot,
  classifyToolSafety,
  decideToolPolicy,
  decideToolPolicyFromSnapshot,
  isToolPolicyDecisionReason,
} from "./tool-policy.js";
export {
  EVAL_SUITE_SCHEMA_ID,
  EVAL_SUITE_SCHEMA_VERSION,
  MAX_BATCH_CREATE_CASES,
  MAX_CASE_ASSERTIONS,
  MAX_IMPORT_NOTE_CHARS,
  MAX_IMPORT_SOURCE_CASE_KEY_CHARS,
  MAX_REPETITIONS,
  MAX_SUITE_FILE_CASES,
  MAX_SUITE_FILE_TITLE_CHARS,
  RESERVED_CAPTURE_LEVELS,
  RESERVED_MODES,
  RESERVED_REPORTING_MODES,
  evalSuiteFileCaseImportSchema,
  evalSuiteFileCaseSchema,
  evalSuiteFileDefaultsSchema,
  evalSuiteFileHostSchema,
  evalSuiteFileProvenanceSchema,
  evalSuiteFileSchema,
  evalSuiteFileServerSchema,
  evalSuiteFileStructuralSchema,
  evalSuiteFileTargetSchema,
  evalSuiteFileToolPolicySchema,
  evalSuiteFileValiditySchema,
} from "./suite-file.js";

/**
 * The generated JSON Schema (draft 2020-12) for the suite file.
 *
 * Re-exported from the generated `.ts` twin rather than the `.json` artifact:
 * the contract subpath is consumed by three toolchains and only Node-only code
 * in this repo uses JSON import attributes. The `.json` file is the artifact
 * published at the schema's `$id`; the two are byte-identical documents and a
 * test proves it.
 */
export { evalSuiteFileJsonSchema } from "./eval-suite.schema.generated.js";

// ── the run verdict policy (v2) ──────────────────────────────────────────────
export type {
  EvalCaseVerdictAggregation,
  EvalExecutionVariant,
  EvalRateMeasurement,
  EvalRateMeasurementState,
  EvalRunVerdict,
  EvalTaskDecisionReason,
  EvalTrialExclusionReason,
  EvalTrialExclusions,
  EvalValidityCoverage,
  EvalValidityDecisionReason,
  EvalVerdictDecision,
  EvalVerdictDecisionReason,
  EvalVerdictPolicyVersion,
  EvalVerdictValidity,
  ResolvedEvalValidityPolicy,
} from "./verdict-policy.js";
export {
  EVAL_CASE_AGGREGATION_KEY_SEPARATOR,
  EVAL_RATE_MEASUREMENT_STATES,
  EVAL_RUN_VERDICTS,
  EVAL_TASK_DECISION_REASONS,
  EVAL_TRIAL_EXCLUSION_REASONS,
  EVAL_VALIDITY_DECISION_REASONS,
  EVAL_VERDICT_DECISION_REASONS,
  EVAL_VERDICT_POLICY_SCHEMA_ID,
  EVAL_VERDICT_POLICY_VERSION,
  evalCaseAggregationKey,
  evalCaseVerdictAggregationSchema,
  evalCaseVerdictAggregationStructuralSchema,
  evalExecutionVariantSchema,
  evalFractionSchema,
  evalRateMeasurementSchema,
  evalRateMeasurementStateSchema,
  evalRateMeasurementStructuralSchema,
  evalRunVerdictSchema,
  evalTrialExclusionReasonSchema,
  evalTrialExclusionsSchema,
  evalValidityCoverageSchema,
  evalVerdictDecisionReasonSchema,
  evalVerdictDecisionSchema,
  evalVerdictDecisionStructuralSchema,
  evalVerdictPolicyVersionSchema,
  isEvalRunVerdict,
  isEvalTrialExclusionReason,
  isEvalValidityDecisionReason,
  isEvalVerdictDecisionReason,
  isEvalVerdictPolicyV2,
  resolvedEvalValidityPolicySchema,
} from "./verdict-policy.js";

/**
 * The generated JSON Schema (draft 2020-12) for a v2 verdict decision.
 *
 * STRUCTURAL only, for the reason its own docblock gives: the arithmetic and
 * phase-ordering rules are zod refinements. Same `.ts`-twin rule as the suite
 * file above.
 */
export { evalVerdictPolicyJsonSchema } from "./eval-verdict-policy.schema.generated.js";

// ── user-facing words for the closed vocabularies ────────────────────────────
export {
  DECISION_LABEL_VOCABULARIES,
  DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION,
  DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION,
  EVAL_VERDICT_DECISION_REASON_LABELS,
  EXCLUDED_TRIAL_DETAIL_LABELS,
  FAILURE_CATEGORY_LABELS,
  NEXT_ACTION_BY_FAILURE_CATEGORY,
  STAGE_REASONS_WITHOUT_REMEDY,
  STAGE_REASON_LABELS,
  STAGE_REASON_REMEDIES,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  USER_VALUE_STAGE_QUESTIONS,
  describeExcludedTrialDetail,
} from "./decision-labels.js";
export type { EvalStageCoverageDetailKey } from "./decision-labels.js";

// ── the canonical run decision summary ───────────────────────────────────────
export type {
  EvalRunDecisionAssemblyInput,
  EvalRunDecisionChain,
  EvalRunDecisionCounts,
  EvalRunDecisionDiagnostic,
  EvalRunDecisionDiagnostics,
  EvalRunDecisionEvidence,
  EvalRunDecisionIterationInput,
  EvalRunDecisionRunInput,
  EvalRunDecisionSummary,
  EvalRunDecisionSummarySchemaVersion,
  EvalRunDecisionUndecided,
  EvalRunDecisionUndecidedReason,
  EvalRunDecisionVerdict,
  EvalRunDecisionVerdictSource,
  EvalRunMeasurementUnit,
} from "./decision-summary.js";
export {
  EVAL_RUN_DECISION_SUMMARY_SCHEMA_ID,
  EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION,
  EVAL_RUN_DECISION_UNDECIDED_REASONS,
  EVAL_RUN_DECISION_VERDICTS,
  EVAL_RUN_DECISION_VERDICT_SOURCES,
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  EVAL_RUN_DECISION_VERDICT_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
  EVAL_RUN_MEASUREMENT_UNITS,
  EVAL_RUN_MEASUREMENT_UNIT_LABELS,
  assembleEvalRunDecisionChain,
  assembleEvalRunDecisionSummary,
  decisionDiagnosticFailureCategory,
  decisionDiagnosticFirstFailedStage,
  evalIterationTracePath,
  evalRunDecisionChainSchema,
  evalRunDecisionCountsSchema,
  evalRunDecisionDiagnosticSchema,
  evalRunDecisionDiagnosticsSchema,
  evalRunDecisionEvidenceSchema,
  evalRunDecisionSummarySchema,
  evalRunDecisionSummaryStructuralSchema,
  evalRunDecisionUndecidedReasonSchema,
  evalRunDecisionUndecidedSchema,
  evalRunDecisionVerdictSchema,
  evalRunDecisionVerdictSourceSchema,
  evalRunMeasurementUnitSchema,
  measurementUnitLabel,
} from "./decision-summary.js";
