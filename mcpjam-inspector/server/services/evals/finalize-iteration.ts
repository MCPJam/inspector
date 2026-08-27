import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type {
  EvalTraceSpan,
  EvalTraceWidgetSnapshot,
  PromptTraceSummary,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";
import { uploadVideoBlob } from "../../utils/mcp-app-widget-capture.js";
import type { UsageTotals } from "./types.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import { emitBrowserEvalMetrics } from "./browser-eval-metrics.js";
import {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "./finalize-iteration-browser-artifacts.js";
import { buildIterationUsageMetadata } from "./iteration-usage-metadata.js";
import { buildIterationMetadata } from "./iteration-metadata.js";
import {
  buildHostIterationMetadata,
  type HostExecutionPolicy,
  type ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
import {
  attachStageMeasurements,
  deriveStageResults,
  stageDerivationToMetadata,
  type EvalSuiteFileToolPolicy,
  type StageAuthoredCase,
  type StageEvidence,
  type StageResultRow,
  type StageSetupSignals,
  type IterationStatus as ContractIterationStatus,
  allGatingScorersPassed,
} from "@mcpjam/sdk/contract";
import {
  isDualWrite,
  isEnforcing,
  resolveGradingEngineMode,
  type GradingEngineMode,
} from "./grading-mode.js";
import {
  buildHostedScoreContract,
  shadowVerdictFromScores,
  type HostedEvaluationLike,
  type HostedPredicateResultLike,
} from "./score-rows.js";
import { buildShadowMismatch, emitShadowMismatch } from "./shadow-mismatch.js";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./persist-eval-trace.js";
import { isTerminalIterationStatus } from "./run-status.js";
import {
  buildSelectionToolCatalog,
  type SelectionCatalogToolLike,
} from "./selection-tool-catalog.js";

/**
 * The canonical lifecycle vocabulary, imported rather than re-spelled: this
 * file used to declare a three-value subset of it, which is what forced a
 * runner whose ENVIRONMENT never came up to report `failed` — a word that says
 * something about the server under test.
 *
 * Lifecycle is not the verdict. A run that asked the question and got the wrong
 * answer is `completed` + `result: "failed"`; `failed` is reserved for the
 * execution itself breaking.
 */
type IterationStatus = ContractIterationStatus;

type ToolCallRecord = {
  toolName: string;
  arguments: Record<string, any>;
  /**
   * Mirrors the runner's `ToolCall.toolCallId`. This type describes exactly
   * what goes over the wire as `updateTestIteration.actualToolCalls`, so it
   * has to name every field the runner actually sends — the whole reason
   * `toolCallId` reached a validator that rejected it is that no type on this
   * path admitted the field existed.
   */
  toolCallId?: string;
};
type PolicyBlockRecord = { reason?: unknown };

/**
 * Stage derivation uses the first recorded block as the stable iteration
 * summary reason when multiple policy blocks occur.
 */
function getIterationPolicyReason(
  policyBlocks: ReadonlyArray<PolicyBlockRecord>
): string | undefined {
  const reason = policyBlocks[0]?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Adapt what the runner captured into the analyzer's evidence shape.
 *
 * The only subtle part is the two "we have no spans" flags, which are NOT
 * interchangeable and which the analyzer reports differently:
 *
 *   - `traceAbsent` — nothing was captured at all. The row exists (a setup
 *     failure, a lifecycle stop) and carries no transcript.
 *   - `traceLacksSpanChannel` — a transcript exists (messages and/or per-turn
 *     summaries) but no spans. That is the caller-supplied `HostExecutor`
 *     signature: the run DID happen and this executor simply never reports
 *     what happened. Collapsing it into "nothing happened" is precisely how a
 *     run with every tool call failing passes vacuously.
 */
function buildStageEvidence(args: {
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  messages?: ModelMessage[];
  predicateResults?: unknown[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  /**
   * Pinned (model-free) tool-call failures. These never enter the trace — the
   * same blind spot `buildEvalIterationVerdict` compensates for when it applies
   * `failOnToolError` to them explicitly — so without them a pinned tool
   * failure would leave `call`/`response` looking unmeasured.
   */
  toolErrors?: unknown[];
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
  /** Advisory judge evidence. Absent on the first pass; see {@link buildStageMetadata}. */
  judgeEvidence?: StageEvidence["judgeEvidence"];
  /** D7's advisory attribution evidence. Absent on the first pass, same as `judgeEvidence`. */
  metadataAttribution?: StageEvidence["metadataAttribution"];
}) {
  const hasSpans = (args.spans?.length ?? 0) > 0;
  const hasPrompts = (args.prompts?.length ?? 0) > 0;
  const hasMessages = (args.messages?.length ?? 0) > 0;
  return {
    ...(hasSpans ? { spans: args.spans } : {}),
    ...(hasPrompts ? { prompts: args.prompts } : {}),
    ...(args.predicateResults?.length
      ? {
          predicateResults: args.predicateResults as ReadonlyArray<{
            passed?: boolean;
            reason?: string;
          }>,
        }
      : {}),
    ...(args.widgetRenderObservations?.length
      ? { renderObservations: args.widgetRenderObservations }
      : {}),
    ...(args.toolErrors?.length
      ? {
          toolErrors: args.toolErrors as ReadonlyArray<{
            kind?: string;
            toolName?: string;
          }>,
        }
      : {}),
    ...(args.toolSignals ? { toolSignals: args.toolSignals } : {}),
    ...(args.setupSignals ? { setupSignals: args.setupSignals } : {}),
    ...(args.judgeEvidence ? { judgeEvidence: args.judgeEvidence } : {}),
    ...(args.metadataAttribution
      ? { metadataAttribution: args.metadataAttribution }
      : {}),
    traceAbsent: !hasSpans && !hasPrompts && !hasMessages,
    traceLacksSpanChannel: !hasSpans && (hasPrompts || hasMessages),
  };
}

/**
 * Derive one iteration's user-value chain metadata, or `{}` when the caller
 * cannot say what the case authored.
 *
 * Exported because a SETUP ABORT never reaches `buildIterationFinishParams`:
 * `persistSetupFailedIteration` writes its own minimal row for an iteration
 * that threw before the prompt loop started. That is exactly the shape the
 * chain has a dedicated verdict for — every applicable stage `notMeasured` for
 * `setupAborted`, `failureCategory: "setup"` — so leaving that path out would
 * file a case that demonstrably died in setup as having no chain at all, which
 * reads identically to an old SDK that reports no chain. Both callers derive
 * through here so the two cannot drift.
 *
 * THIS PRODUCER'S OUTPUT IS NOT FINAL. The LLM judge finishes after the run
 * does, so a SECOND derivation pass (`judge-second-pass.ts`, reached via the
 * `judge-completed` doorbell) re-derives these same rows with `judgeEvidence`
 * present and REWRITES the stage keys. A reader of `metadata.stageResults` is
 * reading whichever pass wrote last; only `passed` — never derived here — is
 * authoritative in every pass and every mode.
 */
export function buildStageMetadata(args: {
  stageCase?: StageAuthoredCase;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  messages?: ModelMessage[];
  predicateResults?: unknown[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  stageToolErrors?: unknown[];
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
  /**
   * ABSENT on the first pass (the judge has not run yet), PRESENT on the
   * second. Tier 2: it can only decide `userValue` where the deterministic
   * evidence said nothing.
   */
  judgeEvidence?: StageEvidence["judgeEvidence"];
  /**
   * ABSENT on the first pass, PRESENT on the second. Tier 2, same
   * subordination as `judgeEvidence`: it can only decide `selection`'s
   * `failureCategory` where D1 already derived `selection: failed`.
   */
  metadataAttribution?: StageEvidence["metadataAttribution"];
  policy?: { blocked: boolean; reason?: string };
  /**
   * The EXECUTION lifecycle status, forwarded to the analyzer unchanged. The
   * stopped states (`cancelled`, `timed_out`, `setup_failed`, `skipped`) are
   * what let it report a stage as `notMeasured` rather than failed, so
   * narrowing them to `failed` here would file evidence gaps as findings.
   */
  status: IterationStatus;
  error?: string;
}): Record<string, unknown> {
  const { stageCase, status, error } = args;
  if (!stageCase) return {};
  // Derive ONCE, serialize, then measure the SERIALIZED rows. The measurements
  // describe the exact chain that gets stored, so a second derivation — here or
  // anywhere else — could only produce a pair able to disagree with itself.
  return attachStageMeasurements(
    stageDerivationToMetadata(
      deriveStageResults({
        authored: stageCase,
        evidence: buildStageEvidence({
          spans: args.spans,
          prompts: args.prompts,
          messages: args.messages,
          predicateResults: args.predicateResults,
          widgetRenderObservations: args.widgetRenderObservations,
          toolErrors: args.stageToolErrors,
          toolSignals: args.toolSignals,
          setupSignals: args.setupSignals,
          ...(args.judgeEvidence ? { judgeEvidence: args.judgeEvidence } : {}),
          ...(args.metadataAttribution
            ? { metadataAttribution: args.metadataAttribution }
            : {}),
        }),
        iteration: { status, ...(error ? { error } : {}) },
        policy: args.policy,
      }),
    ),
    args.spans,
  );
}

/** A predicate row the score projection can key a criterion off. */
function isHostedPredicateResult(
  value: unknown
): value is HostedPredicateResultLike {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { predicate?: unknown; passed?: unknown };
  return (
    typeof row.passed === "boolean" &&
    typeof row.predicate === "object" &&
    row.predicate !== null
  );
}

/** Read only the matcher fields the projection needs, typed rather than cast. */
function narrowEvaluation(
  evaluation: Record<string, unknown>
): HostedEvaluationLike {
  const list = (key: string): readonly unknown[] | undefined => {
    const value = evaluation[key];
    return Array.isArray(value) ? value : undefined;
  };
  return {
    ...(typeof evaluation.passed === "boolean"
      ? { passed: evaluation.passed }
      : {}),
    ...(list("expectedToolCalls")
      ? { expectedToolCalls: list("expectedToolCalls") }
      : {}),
    ...(list("missing") ? { missing: list("missing") } : {}),
    ...(list("unexpected") ? { unexpected: list("unexpected") } : {}),
    ...(list("argumentMismatches")
      ? { argumentMismatches: list("argumentMismatches") }
      : {}),
  };
}

/**
 * The score-contract keys this mode contributes to iteration metadata, plus —
 * at `enforce` only — the verdict those rows derive.
 *
 * `off` returns `{}` — not empty arrays, not `undefined` values — so the
 * persisted payload is byte-identical to today's. `shadow` writes ONLY the
 * shadow keys; `dual_write` and `enforce` write ONLY the real ones: no mode
 * writes both, which is what makes a shadow row impossible to mistake for a
 * decided one.
 *
 * ── What `enforce` changes, and what it does not ────────────────────────────
 *
 * The PERSISTED KEYS are identical to `dual_write`'s. That is deliberate and it
 * is what makes the rollback a flag flip: dropping a cohort from `enforce` to
 * `dual_write` needs no migration in either direction, because the two modes
 * wrote the same fields.
 *
 * What changes is authority. At `enforce` this returns `derived`, and the
 * caller uses `derived.passed` as the iteration's outgoing `result` instead of
 * the boolean pipeline's `passed`. The rule is the contract's
 * `allGatingScorersPassed` — every gating definition resolved AND every one
 * that resolved to a verdict passed — read STRICTLY, so a gating scorer that
 * errored or was skipped fails the iteration rather than being ignored. Zero
 * evidence never passes, which is also what the legacy pipeline does with an
 * unscorable criterion.
 *
 * ── The evaluation itself is untouched ──────────────────────────────────────
 *
 * `buildEvalIterationVerdict` still runs, still produces `passed`, and is still
 * the thing these rows are a projection OF. What retires at `enforce` is the
 * parallel verdict ARITHMETIC, not the evaluation: the matcher, the predicates
 * and the gates all still decide, and the rows report what they decided. That
 * is why a mismatch between `derived.passed` and `passed` is expected to be
 * ZERO at `shadow` and `dual_write` — two projections of one evaluation cannot
 * honestly disagree — and why a nonzero rate there is a bug signal.
 *
 * AT `enforce` THAT IS NOT QUITE TRUE, and reading it as though it were would
 * make the soak dishonest. The comparison switches to the STRICT reading, and
 * strictness is a DESIGNED divergence: a gating definition that resolved to no
 * usable verdict — no row at all, or an `error`/`skipped` row whose own
 * `onError`/`onSkipped` policy says `fail` — fails the derived verdict where
 * the legacy boolean pipeline may have passed the iteration. That is the
 * safety `enforce` is bought for (zero evidence never passes), so when it
 * fires it is the feature working.
 *
 * So an enforce-mode `grading_shadow_mismatch` means "legacy and strict
 * disagree — investigate", not "something is broken". Check
 * `unresolvedScorerIds`: populated means a designed strictness catch;
 * `disagreeingScorerIds` alone means a real projection bug.
 */
function buildScoreMetadata(args: {
  mode: GradingEngineMode;
  predicateResults?: unknown[];
  evaluation: Record<string, unknown>;
  matchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
  /** Identity for the shadow comparison. Absent ⇒ no comparison is emitted. */
  runId?: string;
  iterationId?: string;
  /** The authoritative verdict, compared against but never derived from. */
  passed: boolean;
  stageMetadata: Record<string, unknown>;
}): {
  keys: Record<string, unknown>;
  /** Present ONLY at `enforce`. The verdict the gating rows derive. */
  derived?: { passed: boolean; blamedScorerIds: string[] };
} {
  if (args.mode === "off") return { keys: {} };
  const predicateResults = (args.predicateResults ?? []).filter(
    isHostedPredicateResult
  );
  const { scores, evaluationConfig } = buildHostedScoreContract({
    ...(predicateResults.length ? { predicateResults } : {}),
    evaluation: narrowEvaluation(args.evaluation),
    ...(args.matchOptions ? { matchOptions: args.matchOptions } : {}),
    ...(args.isNegativeTest ? { isNegativeTest: true } : {}),
    // The judge has not run yet on this pass; its row arrives in the second.
  });
  if (scores.length === 0) {
    // NO ROWS AND `enforce`. There is nothing to derive from, so the boolean
    // verdict stands — returning `derived` here would fail every iteration a
    // case authored no gating criteria for. The backend's verify seam reaches
    // the same conclusion independently (`not_derivable`), which is what keeps
    // the two ends of the wire agreeing about a case with nothing to score.
    return { keys: {} };
  }
  // ONE call to the shared arithmetic, read two ways. The SHADOW comparison
  // ignores unresolved gates (an unscorable criterion is not a disagreement);
  // the AUTHORITY reading does not (zero evidence never passes).
  const gating = allGatingScorersPassed(scores, evaluationConfig);
  const enforcing = isEnforcing(args.mode);
  const derived = enforcing
    ? {
        passed: gating.passed,
        blamedScorerIds: [
          ...gating.disagreeingScorerIds,
          ...gating.unresolvedScorerIds,
        ],
      }
    : undefined;
  // Agreement emits NOTHING — the parity harnesses assert exactly that — so
  // this is a comparison, not a report.
  if (args.runId && args.iterationId) {
    // At `enforce` the comparison is against the verdict that actually LANDS,
    // because that is the number a mismatch would move. Below it, the lenient
    // shadow reading is preserved byte for byte.
    const shadow = enforcing
      ? {
          passed: gating.passed,
          disagreeingScorerIds: derived!.blamedScorerIds,
        }
      : shadowVerdictFromScores(scores, evaluationConfig);
    // BOTH sides carry the SAME row on this pass. The score projection does not
    // re-derive the chain — the judge has not spoken yet — so a row difference
    // here would be an artifact of leaving one side blank, not a finding, and
    // it would report `userValueRowChanged` on every iteration that has a row.
    const userValueRow = readUserValueRow(args.stageMetadata);
    const mismatch = buildShadowMismatch(
      {
        runId: args.runId,
        iterationId: args.iterationId,
        passed: args.passed,
        ...(userValueRow ? { userValue: userValueRow } : {}),
      },
      {
        passed: shadow.passed,
        mode: args.mode,
        ...(userValueRow ? { userValue: userValueRow } : {}),
        ...(shadow.disagreeingScorerIds.length
          ? { disagreeingScorerIds: shadow.disagreeingScorerIds }
          : {}),
        evaluationConfigHash: evaluationConfig.hash,
        ...(typeof args.stageMetadata.stageAnalyzerVersion === "number"
          ? { stageAnalyzerVersion: args.stageMetadata.stageAnalyzerVersion }
          : {}),
      }
    );
    // The emitter is only REACHED on disagreement, so a spy on it counts
    // mismatches rather than comparisons — that is what makes
    // `toHaveBeenCalledTimes(0)` a parity result.
    if (mismatch) emitShadowMismatch(mismatch);
  }
  return {
    keys: isDualWrite(args.mode)
      ? { scores, evaluationConfig }
      : { scoresShadow: scores, evaluationConfigShadow: evaluationConfig },
    ...(derived ? { derived } : {}),
  };
}

/**
 * The derived `userValue` row, for the shadow comparison's row-moved check.
 * On this pass both sides read the SAME row (the judge has not spoken), so the
 * comparison can only ever fire on the verdict — which is the point: a
 * first-pass mismatch means the score projection disagrees with `passed`.
 */
function readUserValueRow(
  stageMetadata: Record<string, unknown>
): { state: StageResultRow["state"]; reason: StageResultRow["reason"] } | undefined {
  const rows = stageMetadata.stageResults;
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const candidate = row as Partial<StageResultRow>;
    if (candidate.stage === "userValue" && candidate.state && candidate.reason) {
      return { state: candidate.state, reason: candidate.reason };
    }
  }
  return undefined;
}

/**
 * D7's `metadata.selectionToolCatalog` — written ONLY when this pass's own
 * `stageMetadata` already derived `selection: failed`, so the common
 * (passing) case costs nothing. Reads `missing` / `unexpected` from the
 * SAME `prompts` array `deriveSelection` used to reach that verdict — this
 * never re-derives whether selection failed, it only explains what the
 * model was choosing between when it did.
 */
function buildSelectionToolCatalogMetadata(args: {
  stageMetadata: Record<string, unknown>;
  prompts?: PromptTraceSummary[];
  selectionTools?: Record<string, SelectionCatalogToolLike>;
}): Record<string, unknown> {
  if (!args.selectionTools) return {};
  const rows = args.stageMetadata.stageResults;
  if (!Array.isArray(rows)) return {};
  const selectionRow = rows.find(
    (row): row is Partial<StageResultRow> =>
      typeof row === "object" && row !== null && (row as { stage?: unknown }).stage === "selection"
  );
  if (selectionRow?.state !== "failed") return {};

  const prompts = args.prompts ?? [];
  // Only turns that were PART OF this selection failure — a successful
  // earlier turn's tool calls have nothing to do with why selection failed,
  // and folding them in could fill the catalog's cap before the turn that
  // actually caused the failure is ever considered.
  const failingPrompts = prompts.filter(
    (p) => (p.missing?.length ?? 0) > 0 || (p.unexpected?.length ?? 0) > 0
  );
  const expectedToolNames = failingPrompts
    .flatMap((p) => p.missing ?? [])
    .map((t) => t.toolName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  // `unexpected` names FIRST, then the rest of the turn's actual calls:
  // `buildSelectionToolCatalog`'s cap is shared across both roles, and for
  // an `unexpectedToolCall` failure (e.g. `maxExtraToolCalls: 0`, six
  // correctly-called expected tools plus one prohibited extra) the extra
  // that actually caused the failure could otherwise sit last in call order
  // and get crowded out by the tools that were selected correctly. The full
  // actual set still matters beyond just `unexpected`, though: under the
  // default `maxExtraToolCalls: null`, a call the model made INSTEAD of
  // (not in addition to) an expected one stays out of `unexpected` — it
  // only ever lands there as a flagged extra — so `missingToolCall` cases
  // still need the broader `actualToolCalls` set to see what was chosen.
  const unexpectedToolNames = failingPrompts
    .flatMap((p) => p.unexpected ?? [])
    .map((t) => t.toolName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const otherActualToolNames = failingPrompts
    .flatMap((p) => p.actualToolCalls ?? [])
    .map((t) => t.toolName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const actualToolNames = [...unexpectedToolNames, ...otherActualToolNames];
  if (expectedToolNames.length === 0 && actualToolNames.length === 0) {
    return {};
  }

  const catalog = buildSelectionToolCatalog({
    tools: args.selectionTools,
    expectedToolNames,
    actualToolNames,
  });
  return catalog.length > 0 ? { selectionToolCatalog: catalog } : {};
}

/**
 * Builds the `finishParams` object every runner passes to
 * {@link finalizeIterationWithBrowserArtifacts} (which adds `videoBytes` +
 * `convexClient` and dispatches to the recorder or `finalizeEvalIteration`).
 *
 * PR3 of the runner unification (plan: we-need-robustness-and-jaunty-toast.md):
 * the four runners built this object inline, identical in shape but with
 * per-runner variable names. Centralizing it removes the drift risk. The
 * `error`/`errorDetails` fields are normalized to omit-when-absent (the local
 * runners' shape); this is cosmetic for persisted output because
 * `finalizeEvalIteration` forwards both to Convex unconditionally anyway (see
 * invariant #7 in the plan), so the golden Convex-payload snapshots are
 * unchanged.
 */
export function buildIterationFinishParams(args: {
  iterationId: string | undefined;
  passed: boolean;
  /** `evaluation` drives both `toolsCalled` and `buildIterationMetadata`. */
  evaluation: { toolsCalled: ToolCallRecord[] } & Record<string, unknown>;
  usage: UsageTotals;
  messages: ModelMessage[];
  /** The model selected for this iteration, used for session attribution. */
  modelId?: string;
  systemPrompt?: string;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  browserInteractionSteps?: RunnerBrowserInteractionStep[];
  /**
   * REQUIRED and explicit. Callers classify their own path — a graded task
   * failure is `completed`, a setup abort `setup_failed`, a budget expiry
   * `timed_out` — because `passed` cannot distinguish them and never could.
   */
  status: IterationStatus;
  startedAt: number;
  error?: string;
  errorDetails?: string;
  /** Case-level + per-turn predicate results; persisted to metadata.predicates. */
  predicateResults?: unknown[];
  /** Fail-fast skipped steps (PR6); persisted to metadata.skippedSteps. */
  skippedSteps?: unknown[];
  /**
   * One verdict row per authored step (`buildStepResultRecords`); persisted to
   * `metadata.stepResults`. The clean per-step contract the public `/steps` API
   * projects — `stepId`-keyed status+reason for every kind, where the lossy
   * `predicates` rows lack `stepId` and interact failures aren't otherwise saved.
   */
  stepResults?: unknown[];
  /**
   * The authored case's stage-applicability inputs, from
   * `buildStageAuthoredCase`.
   *
   * PRESENT ⇒ this iteration gets a derived user-value chain under
   * `metadata.stageResults` (+ `firstFailedStage` / `failureCategory` /
   * `stageAnalyzerVersion`). ABSENT ⇒ no stage keys are written at all, which
   * is the honest default for a caller that cannot say what the case authored:
   * without the authored case there is no way to tell `notApplicable` from
   * `notMeasured`, and guessing would report a stage the case never exercised
   * as an evidence gap.
   *
   * Threaded as its own argument rather than folded into
   * `iterationMetadataBase` because `buildIterationMetadata` is typed
   * scalar-only (`Record<string, string | number | boolean>`) and
   * `stageResults` is an array of rows.
   */
  stageCase?: StageAuthoredCase;
  /**
   * Pinned tool-call failures, for the stage derivation only (the verdict
   * gates on them separately). Never enter the trace, so the chain is blind to
   * them unless they are threaded here.
   */
  stageToolErrors?: unknown[];
  /** Execution-layer policy blocks; persisted as metadata, never a failure. */
  policyBlocks?: PolicyBlockRecord[];
  /** Non-fatal policy configuration warnings, persisted for run consumers. */
  policyWarnings?: string[];
  /**
   * The effective tool policy this iteration executed under, snapshotted the
   * same way `hostPolicy` evidence is: the run row has no field to carry it
   * (a backend `toolPolicy` column is Lane B), so without this snapshot a
   * REPLAY of a policied run cannot reconstruct the policy — and a replay
   * re-dials the ORIGINAL servers with the original credentials
   * (`MCPServerReplayConfig`), so an unreconstructed policy means the calls we
   * blocked run for real the second time.
   */
  toolPolicy?: EvalSuiteFileToolPolicy;
  iterationMetadataBase: Record<string, string | number | boolean>;
  hostPolicy?: HostExecutionPolicy;
  toolSignals?: ToolExposureSignals;
  /**
   * Folded run-level connect / tools-list evidence. Threaded into the
   * analyzer; the same signals are also persisted under
   * `metadata.stageSetupAudit.signals` (see `setupAudit`) so a v2 verdict
   * can be audited or recomputed.
   */
  setupSignals?: StageSetupSignals;
  /**
   * Synthetic connection/discovery spans. Persisted on the trace (timeline)
   * but never enter stage-derivation evidence.
   */
  setupSpans?: EvalTraceSpan[];
  /** Bounded canary/audit extras from the run-setup observer. */
  setupAudit?: Record<string, unknown>;
  injectOpenAiCompat?: boolean;
  /**
   * The run's resolved grading-engine mode. ABSENT ⇒ resolve from the env kill
   * switch alone, which is `off` unless an operator set it, so a caller that
   * knows nothing about the score engine keeps today's payload byte for byte.
   *
   *   `off`        → no score keys at all.
   *   `shadow`     → `scoresShadow` / `evaluationConfigShadow` ONLY.
   *   `dual_write` → `scores` / `evaluationConfig` ONLY.
   *
   * Synchronous in every mode: the projection is pure and adds no awaits, so
   * the runner's finalization path gains no latency.
   */
  gradingMode?: GradingEngineMode;
  /** Match options + polarity, hashed into the `toolCalls:match` definition. */
  scoreMatchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
  /**
   * The run this iteration belongs to. Used ONLY to key shadow-mismatch
   * telemetry (dedupe + the per-run cap); absent ⇒ no comparison is emitted,
   * which is why a quick run with no run row stays silent.
   */
  runId?: string;
  /**
   * D7: the live tool registry, keyed by name, as the runner had it in
   * scope THIS iteration. Absent ⇒ no `selectionToolCatalog` is written,
   * same honest-default reasoning `stageCase` follows for the stage chain
   * itself — a caller with no live registry cannot say what the model saw.
   */
  selectionTools?: Record<string, SelectionCatalogToolLike>;
}): Omit<FinalizeEvalIterationParams, "convexClient" | "videoBytes"> {
  const {
    iterationId,
    passed,
    evaluation,
    usage,
    messages,
    modelId,
    systemPrompt,
    spans,
    prompts,
    widgetSnapshots,
    widgetRenderObservations,
    browserInteractionSteps,
    status,
    startedAt,
    error,
    errorDetails,
    predicateResults,
    skippedSteps,
    stepResults,
    stageCase,
    stageToolErrors,
    policyBlocks,
    policyWarnings,
    toolPolicy,
    iterationMetadataBase,
    hostPolicy,
    toolSignals,
    setupSignals,
    setupSpans,
    setupAudit,
    injectOpenAiCompat,
    scoreMatchOptions,
    isNegativeTest,
    selectionTools,
  } = args;
  const gradingMode = args.gradingMode ?? resolveGradingEngineMode();
  const persistedSpans = [
    ...(setupSpans ?? []),
    ...(spans ?? []),
  ];
  const stageMetadata = buildStageMetadata({
    ...(stageCase ? { stageCase } : {}),
    spans,
    prompts,
    messages,
    predicateResults,
    widgetRenderObservations,
    stageToolErrors,
    toolSignals,
    setupSignals,
    policy:
      policyBlocks &&
      policyBlocks.length > 0 &&
      !error &&
      !(stageToolErrors && stageToolErrors.length > 0)
        ? {
            blocked: true,
            reason: getIterationPolicyReason(policyBlocks),
          }
        : undefined,
    status,
    ...(error ? { error } : {}),
  });
  const { keys: scoreMetadata, derived } = buildScoreMetadata({
    mode: gradingMode,
    predicateResults,
    evaluation,
    passed,
    stageMetadata,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(iterationId ? { iterationId } : {}),
    ...(scoreMatchOptions ? { matchOptions: scoreMatchOptions } : {}),
    ...(isNegativeTest ? { isNegativeTest } : {}),
  });
  // Gated on the same `gradingMode` that decides whether `scoreMetadata`
  // above writes anything — D7 changes nothing outside `dual_write` (see the
  // plan's §15 disclosure note), and that includes not capturing server tool
  // descriptions/schemas into iteration metadata for a suite that never
  // opted in.
  // `isDualWrite`, not `=== "dual_write"`: B3b added `enforce` ABOVE
  // dual_write and it writes the same real rows, so an equality check here
  // would silently switch D7's catalog capture back OFF for the cohort that
  // has progressed furthest. The predicate is what keeps "dual_write and
  // above" in one place.
  const selectionToolCatalogMetadata =
    isDualWrite(gradingMode)
      ? buildSelectionToolCatalogMetadata({
          stageMetadata,
          prompts,
          selectionTools,
        })
      : {};

  // THE FLIP, and the ONE DIRECTION IT MAY MOVE.
  //
  // At `enforce` the gating score rows decide — but only ever toward FAILED.
  // The rows are a projection of the evaluation, and that projection is NOT
  // YET TOTAL: `buildEvalIterationVerdict` also gates on `failOnToolError`,
  // pinned tool errors, `iterationError` and `scriptedCheckFailures`, and none
  // of those produce a score row today. A case with one passing predicate and
  // no authored tool-call expectations that fails on a scripted check has an
  // all-passing row set — so reading the rows as the SOLE authority would turn
  // that failure into a pass.
  //
  // Promoting a failure to a pass is the one thing this cutover must never do,
  // and it is not detectable downstream: the backend's verify seam derives
  // from the same incomplete projection and would agree. So the conjunction is
  // the guard, and it is structural rather than a policy someone can tune.
  //
  // WHAT `enforce` ADDS ON THIS PATH, STATED HONESTLY — because an earlier
  // version of this comment overstated it.
  //
  // The strict reading fails an iteration whose gating evidence is missing or
  // unscorable (`unresolvedScorerIds`), where the boolean pipeline would have
  // passed it. Zero evidence never passes. That is the property `enforce`
  // exists for — but it is NOT REACHABLE FROM HERE. Every gating definition
  // this pass builds also gets a row, and every one of those rows is `scored`:
  // predicates and `toolCalls:match` always produce a verdict, and the judge is
  // ADVISORY so it never gates. So `unresolvedScorerIds` is always empty on the
  // first pass, and `disagreeingScorerIds` only fires where the boolean already
  // failed the iteration anyway.
  //
  // The strictness catch therefore lives where gating rows can carry
  // `error`/`skipped`: SDK-REPORTED runs, checked by the backend's verify seam,
  // and any second-pass write that adds a gating row. On the hosted first pass
  // `enforce` is currently a no-op in the failing direction — which is exactly
  // what the soak should be expected to show, rather than being read as the
  // feature not working.
  //
  // The conjunction comes OUT when the remaining legacy gates are projected as
  // gating rows; until then it is what keeps N1 honest. `resultSource` stays
  // `"reported"` either way — the inspector is still the thing reporting the
  // verdict, it has changed what it derives it from.
  const effectivePassed = derived ? passed && derived.passed : passed;
  return {
    iterationId,
    passed: effectivePassed,
    toolsCalled: evaluation.toolsCalled,
    usage,
    messages,
    ...(modelId ? { modelId } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(persistedSpans.length ? { spans: persistedSpans } : {}),
    ...(prompts?.length ? { prompts } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    ...(widgetRenderObservations?.length ? { widgetRenderObservations } : {}),
    ...(browserInteractionSteps?.length ? { browserInteractionSteps } : {}),
    status,
    startedAt,
    ...(error ? { error } : {}),
    ...(errorDetails ? { errorDetails } : {}),
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation as never),
      ...(predicateResults?.length ? { predicates: predicateResults } : {}),
      ...(skippedSteps?.length ? { skippedSteps } : {}),
      ...(stepResults?.length ? { stepResults } : {}),
      ...(policyBlocks?.length
        ? {
            policyBlocks,
            policyBlockCount: policyBlocks.length,
          }
        : {}),
      ...(policyWarnings?.length ? { policyWarnings } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      ...stageMetadata,
      ...scoreMetadata,
      ...selectionToolCatalogMetadata,
      ...(setupAudit ?? {}),
      ...(hostPolicy && toolSignals
        ? buildHostIterationMetadata(
            hostPolicy,
            toolSignals,
            evaluation.toolsCalled.length,
            injectOpenAiCompat === true,
          )
        : {}),
    },
  };
}

export type FinalizeEvalIterationParams = {
  convexClient: ConvexHttpClient;
  iterationId?: string;
  passed: boolean;
  toolsCalled: ToolCallRecord[];
  usage: UsageTotals;
  messages: ModelMessage[];
  /** Effective model used by the iteration; persisted on the eval session. */
  modelId?: string;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  /**
   * Resolved system prompt for the eval session. Forwarded to
   * `persistEvalTraceFanout` → `appendEvalTurnTrace.systemPrompt`,
   * which the backend persists to `chatSessions.systemPrompt` with
   * first-write-wins semantics. Also forwarded on the W1 fallback
   * `updateTestIteration` call so the prompt lands even when the
   * fanout failed before any turn wrote.
   */
  systemPrompt?: string;
  /**
   * PR 6b: browser-rendered MCP App eval artifacts collected by the runner
   * (runner-local shape, screenshots still base64). Serialized ONCE here —
   * screenshots uploaded, records sanitized — then forwarded to the W2 fanout
   * and reused on the W1 fallback so neither path re-uploads.
   */
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  browserInteractionSteps?: RunnerBrowserInteractionStep[];
  /**
   * Iteration replay `.webm` bytes from the harness (`browser.collectVideo()`).
   * Uploaded ONCE here (same Convex-storage path as screenshots) → `videoBlobId`
   * forwarded to the W2 fanout and the W1 fallback. Best-effort: a failed upload
   * is logged and dropped — the iteration still finalizes. One video per
   * iteration, so this is iteration-level, not per-turn.
   */
  videoBytes?: Buffer | null;
  /** Explicit harness lifecycle status; never infer it from the verdict. */
  status: IterationStatus;
  startedAt?: number;
  error?: string;
  errorDetails?: string;
  resultSource?: "reported" | "derived";
  // Scalar signals (argumentMismatchCount, host exposure counts, …) plus the
  // nested `predicates: PredicateResult[]` rows. Persisted to
  // `testIteration.metadata`; the Convex validator accepts nested values.
  metadata?: Record<string, unknown>;
  /**
   * Recorder hook: called when the iteration update returns a
   * "not found" / "unauthorized" / "cancelled" error so the caller can
   * short-circuit further calls on this run. Direct callers (no recorder)
   * pass nothing.
   */
  onRunDeleted?: () => void;
};

/**
 * Shared finalize step for both the multi-iteration suite-run recorder
 * (`SuiteRunRecorder.finishIteration`) and the quick-run direct path
 * (where `runId === null`). Owns:
 *   - early bail when there is no `iterationId`
 *   - cancellation pre-check via `getTestIteration`
 *   - status / result / terminalReason derivation
 *   - per-turn fanout via `persistEvalTraceFanout`
 *   - W1 single-call fallback (`messages` + optional trace fields) when
 *     the fanout failed before any turn landed
 *   - `updateTestIteration` call with sanitized metadata
 *   - terminal lock via `lockEvalSessionAfterUpdate` (post-update)
 *
 * The two paths used to be near byte-identical (`recorder.ts` vs
 * `evals-runner.ts:finishIterationDirectly`). The systemPrompt-slot PR
 * series (mcpjam-backend #448 + #449, inspector #2481) had to fix the
 * same W1 fallback bug — `systemPrompt` was dropped — in BOTH paths.
 * This collapse prevents the next instance of that bug class.
 *
 * Suite-run-scoped state (the recorder's `runDeleted` short-circuit
 * flag) stays in the recorder; it surfaces here as the `onRunDeleted`
 * callback fired in the same error branches the recorder used to flip
 * `runDeleted` in directly.
 */
export async function finalizeEvalIteration(
  params: FinalizeEvalIterationParams,
): Promise<void> {
  const {
    convexClient,
    iterationId,
    passed,
    toolsCalled,
    usage,
    messages,
    modelId,
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations,
    browserInteractionSteps,
    videoBytes,
    status,
    startedAt,
    error,
    errorDetails,
    resultSource,
    metadata,
    onRunDeleted,
  } = params;

  if (!iterationId) {
    return;
  }

  // Check if the iteration is already in a terminal stop state before trying
  // to update. A timed-out iteration whose original LLM/browser work ignores
  // the abort and completes late must NOT overwrite the `timed_out` row with a
  // completed/failed result — every terminal lifecycle status is protected.
  try {
    const iteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId },
    );
    if (isTerminalIterationStatus(iteration?.status)) {
      logger.debug(
        "[evals] Skipping update for terminal iteration:",
        iterationId,
        iteration.status,
      );
      return;
    }
  } catch {
    // If we can't check status, continue anyway.
  }

  const iterationStatus = status;
  // The TASK verdict, independent of the lifecycle above: `completed` +
  // `failed` is a run that worked and a case that did not.
  const result = passed ? "passed" : "failed";

  // PR-2 eval→chatSessions fanout: write the transcript as per-turn rows
  // BEFORE calling updateTestIteration. The fanout no longer fires the
  // terminal lock — that happens AFTER updateTestIteration succeeds so
  // a downstream iteration-row failure cannot leave a locked transcript
  // without a finalized iteration (PR-2 review fix #2, Cursor
  // #ed44ef40). Idempotent on retry.
  //
  // Fanout result drives whether we still pass trace fields to
  // updateTestIteration:
  //   - persisted:true  → trace lives in chatSessions; updateTestIteration
  //                       called WITHOUT trace fields (no double-persist)
  //   - persisted:false → fanout failed before any turn landed; fall
  //                       back to the legacy single-call path so the
  //                       iteration is still complete and replayable.
  //
  // lockReason describes the transcript LIFECYCLE (did the eval cycle
  // run to completion?), NOT the verdict. A failed-verdict iteration
  // that ran cleanly (status: "completed", result: "failed") still gets
  // eval_completed; eval_failed is reserved for cycle failures like
  // provider errors, MCP transport crashes, etc. The verdict lives on
  // testIteration.result (passed | failed | pending).
  //
  // The `error != null` check covers a runner quirk (Codex review on
  // #2446): the backend eval paths sometimes set `iterationError` while
  // still calling finishIteration with `status: "completed"` (see
  // evals-runner.ts). Treating those as eval_completed would lock an
  // error transcript with the wrong reason. Presence of `error` is the
  // cycle-failure signal we already have in scope.
  const isCycleFailure =
    iterationStatus === "failed" ||
    iterationStatus === "setup_failed" ||
    iterationStatus === "timed_out" ||
    (error !== undefined && error !== "");
  const terminalReason: "eval_completed" | "eval_failed" | "eval_cancelled" =
    iterationStatus === "cancelled"
      ? "eval_cancelled"
      : isCycleFailure
        ? "eval_failed"
        : "eval_completed";

  // PR 13: emit per-iteration browser-eval observability from the runner-local
  // arrays (covers both the stream + non-stream paths via this shared choke
  // point). Best-effort + no-op when the iteration didn't touch the harness.
  emitBrowserEvalMetrics(widgetRenderObservations, browserInteractionSteps);

  // PR 6b: serialize browser artifacts ONCE here (upload screenshots + run
  // through the convex sanitizer) so the W2 fanout and the W1 fallback share a
  // single upload pass. Owning this in the shared finalize step is what keeps
  // recorder + direct quick-run callers from double-uploading.
  const serializedWidgetRenderObservations =
    await serializeRenderObservationsForBackend(
      widgetRenderObservations,
      convexClient,
    );
  const serializedBrowserInteractionSteps =
    await serializeBrowserStepsForBackend(
      browserInteractionSteps,
      convexClient,
    );

  // Upload the iteration replay video alongside the screenshots, in the same
  // single-pass choke point. Best-effort: a failed upload is logged + dropped
  // (videoBlobId stays undefined → no player) and NEVER fails the iteration.
  let videoBlobId: string | undefined;
  if (videoBytes && videoBytes.length > 0) {
    try {
      videoBlobId = await uploadVideoBlob(convexClient, videoBytes);
    } catch (err) {
      logger.warn("[evals] replay video upload failed; finalizing without it", {
        iterationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fanout = await persistEvalTraceFanout({
    convexClient,
    iterationId,
    iterationStartedAt: startedAt,
    messages,
    ...(modelId ? { modelId } : {}),
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations: serializedWidgetRenderObservations,
    browserInteractionSteps: serializedBrowserInteractionSteps,
    ...(videoBlobId ? { videoBlobId } : {}),
  });
  // Fall back to the W1 single-call path ONLY when the fanout failed
  // before any turn landed. With turns already written, re-sending
  // would overwrite turn 0 (W1 always writes at promptIndex: 0) and
  // orphan turns 1..N. See persist-eval-trace.ts for the contract.
  const useW1Fallback =
    fanout.persisted === false && fanout.turnsWritten === 0;
  if (fanout.persisted === false) {
    logger.warn(
      useW1Fallback
        ? "[evals] persistEvalTraceFanout failed before any turn landed; falling back to W1 single-call save"
        : "[evals] persistEvalTraceFanout failed mid-stream; iteration finalized without re-attempting (would orphan partial turns)",
      {
        iterationId,
        turnsWritten: fanout.turnsWritten,
        error: fanout.error.message,
      },
    );
  }

  // PR-2 review #5 (Cursor "Update failure after successful fanout"):
  // track whether the iteration is gone so we don't waste a lock
  // call on a deleted session, AND so the lock fires even when
  // the iteration update threw a transient error.
  let iterationGoneOrCancelled = false;
  try {
    await convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId,
      status: iterationStatus === "completed" ? "completed" : iterationStatus,
      result,
      actualToolCalls: sanitizeForConvexTransport(toolsCalled),
      tokensUsed: usage.totalTokens ?? 0,
      ...(useW1Fallback
        ? {
            messages: sanitizeForConvexTransport(messages),
            // Mirrors `appendEvalTurnTrace.systemPrompt`. Cursor Bugbot
            // follow-up "W1 omits systemPrompt": without this the W1
            // fallback persists a transcript with no resolved system
            // prompt — the prepend was dropped earlier in the
            // systemPrompt-slot PR series. Backend `updateTestIteration`
            // accepts the slot (mcpjam-backend #449); first-write-wins
            // semantics apply, no risk of clobbering a value already
            // set by an earlier `appendEvalTurnTrace`.
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(spans?.length
              ? { spans: sanitizeForConvexTransport(spans) }
              : {}),
            ...(prompts?.length
              ? { prompts: sanitizeForConvexTransport(prompts) }
              : {}),
            ...(widgetSnapshots?.length
              ? {
                  widgetSnapshots:
                    sanitizeForConvexTransport(widgetSnapshots),
                }
              : {}),
            // PR 6b: browser artifacts already uploaded + sanitized above;
            // strip `promptIndex` (the backend stamps it from the W1 turn's
            // promptIndex: 0). All artifacts land under that single fallback
            // turn — lossy but acceptable, mirroring W1's transcript fallback.
            ...(serializedWidgetRenderObservations.length
              ? {
                  widgetRenderObservations:
                    serializedWidgetRenderObservations.map(
                      toObservationPayload,
                    ),
                }
              : {}),
            ...(serializedBrowserInteractionSteps.length
              ? {
                  browserInteractionSteps:
                    serializedBrowserInteractionSteps.map(toBrowserStepPayload),
                }
              : {}),
            // Iteration replay video already uploaded above; carry the storageId
            // onto the W1 fallback so the replay survives the fanout-failed path.
            ...(videoBlobId ? { videoBlobId } : {}),
          }
        : {}),
      error,
      errorDetails,
      resultSource,
      // Merge user-provided metadata with token usage breakdown, then
      // sanitize: metadata can carry nested predicate rows whose
      // authored args may contain $-prefixed keys Convex rejects at
      // the boundary.
      metadata: sanitizeForConvexTransport({
        ...(metadata ?? {}),
        ...buildIterationUsageMetadata(usage),
      }),
    });
  } catch (caught) {
    const errorMessage =
      caught instanceof Error ? caught.message : String(caught);

    // Check if run was deleted/not found or iteration was cancelled.
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("cancelled")
    ) {
      iterationGoneOrCancelled = true;
      onRunDeleted?.();
    } else {
      logger.error(
        "[evals] Failed to record iteration result:",
        new Error(errorMessage),
      );
      // Transient (non-cancellation) failure: fall through to the lock
      // step. The chatSessions transcript is complete from the fanout's
      // perspective; locking prevents a retry from accumulating partial
      // writes against a row whose data already represents the final
      // state. The iteration row's terminal status remains stale until
      // a retry/cron sweep finalizes it — that's acceptable because
      // the data is consistent at the chatSessions layer.
    }
  }

  // Lock the chatSession when fanout succeeded — runs in BOTH the
  // success branch (updateTestIteration succeeded → defense + UI hint)
  // and the transient-failure branch (updateTestIteration threw a
  // non-cancellation error → prevents partial writes on retry).
  // Skipped only when the iteration is gone, where locking a deleted
  // session is wasted work. Best-effort: lockEvalSessionAfterUpdate
  // swallows its own failures.
  if (fanout?.persisted === true && !iterationGoneOrCancelled) {
    await lockEvalSessionAfterUpdate({
      convexClient,
      iterationId,
      reason: terminalReason,
    });
  }
}
