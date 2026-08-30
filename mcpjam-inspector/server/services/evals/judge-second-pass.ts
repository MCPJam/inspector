/**
 * The second derivation pass: re-derive one run's stage rows now that a
 * judge has spoken.
 *
 * The first pass (`finalize-iteration.ts`) runs while no judge has finished —
 * the runner must not wait on a model — so `userValue` (and, for a selection
 * failure, `failureCategory`) land on whatever deterministic evidence existed
 * at the time. This pass reruns THE SAME pure SDK analyzer
 * (`deriveStageResults`, reached through the same `buildStageMetadata`, never
 * a second implementation) with whichever advisory evidence has since
 * arrived attached, and posts only the derivation-owned keys.
 *
 * TWO judges feed this ONE pass: goal-completion's `judgeVerdict`
 * (`StageEvidence.judgeEvidence`, tier-2 input to `userValue`) and D7's
 * `metadataAttributionVerdict` (`StageEvidence.metadataAttribution`, tier-2
 * input to `selection`'s `failureCategory`). An iteration can carry either,
 * both, or neither — `deriveIterationPayload` builds ONE unified stage
 * derivation from whatever is present, and the two verdicts are then posted
 * to their OWN backend surfaces, keyed by their OWN job id
 * (`goalCompletionJobId` / `metadataAttributionJobId`) and reported to their
 * OWN fanout state, because the two judges are independently triggered
 * (D7 does not require goal-completion to be enabled on the suite at all —
 * see the D7 plan §2/§3) and a write to one must never block or misreport
 * the other.
 *
 * WHAT IT NEVER DOES: touch `passed`, `iteration.result`, or the run's pass/fail
 * counts. That is the whole reason `dual_write` is safe — a judge can move a
 * stage row and a score row, and nothing it does can move a verdict.
 *
 * THAT HOLDS AT `enforce` TOO, and it is the subtlest thing in this module. The
 * judge's row is ADVISORY, so it is structurally excluded from the gating
 * arithmetic that decides the result; the backend refuses lifecycle fields on
 * this route outright (`JUDGE_DERIVATION_LIFECYCLE_FORBIDDEN`); and the
 * backend's own verify seam runs on the merged rows, so if a re-derivation ever
 * DID move the verdict, the run is marked non-gateable rather than quietly
 * re-graded. `enforce` therefore changes what this pass runs FOR (the same real
 * rows `dual_write` writes) and nothing about what it may touch.
 *
 * Idempotent and safe to re-run: the pass reads current state, derives, and
 * posts; the backend rejects a stale job id and refuses terminal iterations,
 * so a duplicate doorbell produces the same rows and the same reports.
 */

import type { StageEvidence } from "@mcpjam/sdk/contract";
import type { Predicate, PredicateScope } from "@mcpjam/sdk/predicates";
import { STAGE_ANALYZER_VERSION } from "@mcpjam/sdk/contract";
import { turnsNeedModel } from "@/shared/steps";
import { logger } from "../../utils/logger.js";
import { buildStageMetadata } from "./finalize-iteration.js";
import { buildStageAuthoredCase } from "./stage-inputs.js";
import {
  isDualWrite,
  resolveFrozenRunGradingMode,
  resolveGradingEngineMode,
  type GradingEngineMode,
} from "./grading-mode.js";
import {
  applyJudgeStageDerivation,
  applyMetadataAttributionStageDerivation,
  fetchRunForJudgeSecondPass,
  markJudgeStageFanout,
  markMetadataAttributionStageFanout,
  JudgeStageBackendError,
  type JudgeDerivationOutcome,
  type JudgeSecondPassIterationRow,
  type JudgeSecondPassRunRow,
} from "./judge-stage-backend.js";
import { buildHostedScoreContract } from "./score-rows.js";

/** Iteration statuses that can still receive a derivation. */
const DERIVABLE_STATUSES = new Set(["completed", "failed"]);

/** The five backend calls this pass makes, injectable for tests. */
export type JudgeSecondPassPorts = {
  fetchRun: typeof fetchRunForJudgeSecondPass;
  applyDerivation: typeof applyJudgeStageDerivation;
  markFanout: typeof markJudgeStageFanout;
  /** D7's write — sibling of `applyDerivation`, own staleness key. */
  applyMetadataAttributionDerivation: typeof applyMetadataAttributionStageDerivation;
  /** D7's fanout report — sibling of `markFanout`, own run-row state. */
  markMetadataAttributionFanout: typeof markMetadataAttributionStageFanout;
};

const defaultPorts: JudgeSecondPassPorts = {
  fetchRun: fetchRunForJudgeSecondPass,
  applyDerivation: applyJudgeStageDerivation,
  markFanout: markJudgeStageFanout,
  applyMetadataAttributionDerivation: applyMetadataAttributionStageDerivation,
  markMetadataAttributionFanout: markMetadataAttributionStageFanout,
};

export type JudgeSecondPassOutcomeEntry = {
  iterationId: string;
  outcome: JudgeDerivationOutcome;
};

export type JudgeSecondPassResult = {
  runId: string;
  mode: GradingEngineMode;
  /** `true` when the pass decided to do nothing (mode, no judge, no run). */
  noop: boolean;
  /** Combined count across both judges — see `outcomes` for goal-completion's own. */
  graded: number;
  /** Goal-completion's own outcomes. Kept as the top-level field for callers
   * that predate D7 — the second, D7-specific set lives in
   * `metadataAttributionOutcomes` so this array's shape never changes. */
  outcomes: JudgeSecondPassOutcomeEntry[];
  /** D7's own outcomes. Empty when this run's `metadataAttributionJobId` is unset. */
  metadataAttributionOutcomes: JudgeSecondPassOutcomeEntry[];
  reason?:
    | "mode_off"
    | "mode_shadow"
    | "run_not_found"
    | "no_job_id"
    | "no_judge_verdicts"
    | "backend_unavailable";
};

/** `metadata.judgeVerdict` as the backend writes it (W2). */
type JudgeVerdictMetadata = {
  status?: unknown;
  verdict?: unknown;
  score?: unknown;
  threshold?: unknown;
  partialFloor?: unknown;
  judgeTemplateVersion?: unknown;
  judgeTemplateHash?: unknown;
  model?: unknown;
  /** Present only in the `error` band — why the judge could not score. */
  error?: unknown;
  /**
   * The judge's own rationale. NOT written today: the backend persists a
   * scored case's `reason` nowhere, only the `error` band's. Read here anyway
   * so that if it ever is persisted the evidence appears without a second
   * change, and so this file names the gap rather than hiding it.
   */
  reason?: unknown;
  reasons?: unknown;
};

/** A finite number, or `undefined` — judge scores arrive as `unknown`. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * What the judge can actually say for itself about this row.
 *
 * Two sources, in order of directness:
 *
 *   1. The judge's own rationale, if the backend ever persists one. Today it
 *      does not for a scored case — `goalCompletion.ts` writes `score`,
 *      `threshold`, `verdict` and (error band only) `error`, and drops the
 *      per-case `reason`. Reading it here costs nothing and closes the gap the
 *      moment the backend writes it.
 *   2. Failing that, the NUMBERS the verdict was actually decided from. Not a
 *      rationale, and not dressed up as one — but "scored 0.42 against a 0.70
 *      threshold" tells a reader which side of the line the run fell and by
 *      how much, where before the row carried nothing at all.
 *
 * Bounded downstream by `boundedJudgeReasons`, the same caps predicate
 * reasons obey.
 */
function judgeReasonsFrom(verdict: JudgeVerdictMetadata): string[] {
  const authored = [
    ...(Array.isArray(verdict.reasons) ? verdict.reasons : []),
    verdict.reason,
    verdict.error,
  ].filter((r): r is string => typeof r === "string" && r.trim().length > 0);
  if (authored.length > 0) return authored;

  const score = finiteNumber(verdict.score);
  const threshold = finiteNumber(verdict.threshold);
  if (score === undefined) return [];

  // The BOUNDARIES that actually decided the band, not just the threshold.
  //
  // A `partial` or `fail` band is settled by the threshold AND the partial
  // floor together, so a line naming only the threshold cannot explain itself:
  // 0.5 against a 0.7 threshold reads as a plain miss, and says nothing about
  // why it failed rather than landing in the partial band. The floor is
  // included exactly when it is one of the numbers the decision turned on.
  // The BAND is `verdict.verdict`; `verdict.status` is the outer state
  // (scored / error / skipped / pending) and never carries a band.
  const band = typeof verdict.verdict === "string" ? verdict.verdict : "";
  const floor =
    band === "partial" || band === "fail"
      ? finiteNumber(verdict.partialFloor)
      : undefined;

  const bounds = [threshold, floor].filter(
    (n): n is number => n !== undefined,
  );
  const show = showAgainst(score, bounds);

  const parts = [`LLM judge scored ${show(score)}`];
  if (threshold !== undefined) parts.push(`against a ${show(threshold)} threshold`);
  if (floor !== undefined) parts.push(`and a ${show(floor)} partial floor`);
  return [parts.join(" ")];
}

/**
 * Pick a rendering precision that cannot contradict the band it explains.
 *
 * Two decimals is right for a person reading a score, and wrong when it erases
 * the very comparison the line exists to show: a 0.699 score against a 0.7
 * threshold rendered as "scored 0.7 against a 0.7 threshold" while the row
 * says it fell short. The numbers then argue with the label, and the reader
 * has no way to tell which is wrong.
 *
 * So precision grows only as far as it must: two places whenever the values
 * are already distinguishable there, and the first deeper precision that keeps
 * every DIFFERENT pair looking different. Equal values still render equal —
 * a score exactly on its threshold should read that way.
 */
function showAgainst(
  score: number,
  bounds: readonly number[],
): (n: number) => string {
  const at = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  // Six is the floor of usefulness, not an arbitrary cap: past it a judge
  // score is float noise, and a line no one can read explains nothing.
  for (let digits = 2; digits <= 6; digits += 1) {
    const collides = bounds.some(
      (bound) => bound !== score && at(bound, digits) === at(score, digits),
    );
    if (!collides) return (n: number) => at(n, digits);
  }
  return (n: number) => at(n, 6);
}

function readJudgeVerdict(
  metadata: Record<string, unknown> | undefined,
): JudgeVerdictMetadata | undefined {
  const verdict = metadata?.judgeVerdict;
  return typeof verdict === "object" && verdict !== null
    ? (verdict as JudgeVerdictMetadata)
    : undefined;
}

/**
 * Project `metadata.judgeVerdict` onto the analyzer's tier-2 evidence.
 *
 * A verdict the judge could not produce becomes `error`, NOT a failure: "the
 * grader broke" and "the product did not deliver" are different rows and the
 * chain has always kept them apart. A `skipped` verdict falls through to
 * whatever the deterministic evidence said, which is the honest reading of a
 * case the judge was never asked about.
 */
export function judgeEvidenceFromVerdict(
  verdict: JudgeVerdictMetadata | undefined,
): StageEvidence["judgeEvidence"] | undefined {
  if (!verdict) return undefined;
  const status = verdict.status;
  const reasons = judgeReasonsFrom(verdict);
  const withReasons = <T extends object>(evidence: T) =>
    reasons.length > 0 ? { ...evidence, reasons } : evidence;
  if (status === "error") {
    return withReasons({ status: "error" as const });
  }
  if (status === "skipped") {
    return { status: "skipped" };
  }
  const band = verdict.verdict;
  if (band === "pass" || band === "partial" || band === "fail") {
    // Every scored row used to ship with no evidence at all: this function
    // never populated `reasons`, so `boundedJudgeReasons` returned undefined
    // on the judge path and `judgeObserved` / `judgePartial` / `judgeFailed`
    // reached a reader as bare verdicts.
    return withReasons({ status: "scored" as const, verdict: band });
  }
  // A verdict row with no band is a judge that was owed an answer and has not
  // produced one — `judgePending`, never a silent pass.
  return { status: "pending", pendingKind: "scheduled" };
}

/** `metadata.metadataAttributionVerdict` as the backend writes it (D7). */
type MetadataAttributionVerdictMetadata = {
  status?: unknown;
  attributed?: unknown;
  reasons?: unknown;
};

function readMetadataAttributionVerdict(
  metadata: Record<string, unknown> | undefined,
): MetadataAttributionVerdictMetadata | undefined {
  const verdict = metadata?.metadataAttributionVerdict;
  return typeof verdict === "object" && verdict !== null
    ? (verdict as MetadataAttributionVerdictMetadata)
    : undefined;
}

/**
 * Project `metadata.metadataAttributionVerdict` onto the analyzer's tier-2
 * evidence. Mirrors `judgeEvidenceFromVerdict`'s subordination rules exactly
 * — a broken judge is `error`, never a failure; a status the backend has not
 * produced yet is `pending`, never a silent `attributed: false`.
 */
export function metadataAttributionEvidenceFromVerdict(
  verdict: MetadataAttributionVerdictMetadata | undefined,
): StageEvidence["metadataAttribution"] | undefined {
  if (!verdict) return undefined;
  const status = verdict.status;
  if (status === "error") {
    return { status: "error" };
  }
  if (status === "skipped") {
    return { status: "skipped" };
  }
  if (status === "scored") {
    const reasons = Array.isArray(verdict.reasons)
      ? verdict.reasons.filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        )
      : undefined;
    return {
      status: "scored",
      attributed: verdict.attributed === true,
      ...(reasons && reasons.length > 0 ? { reasons } : {}),
    };
  }
  if (status === "not_applicable") {
    // A terminal, already-decided outcome ("the judge doesn't apply here")
    // — distinct from `pending`, which means a verdict is still owed. Fell
    // through to `pending` before this branch existed, which would have
    // misled any retry/sweep logic that distinguishes the two.
    return { status: "not_applicable" };
  }
  return { status: "pending", pendingKind: "scheduled" };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * A stored `metadata.predicates` row.
 *
 * The rows were written by the runner from `PredicateResult`, so the shape is
 * ours; the guard narrows the two fields the projection reads rather than
 * trusting the whole document, and the predicate body is passed through to the
 * definition hash exactly as stored (rehashing a re-parsed predicate is how a
 * `definitionHash` stops matching the one the first pass wrote).
 */
type StoredPredicateRow = {
  predicate: Predicate;
  passed: boolean;
  reason?: string;
  /**
   * Absent ⇒ case-level; `{ kind: "turn", promptIndex }` ⇒ per-turn.
   *
   * LOAD-BEARING, and easy to drop. `hostedCriterionId` digests the scope
   * alongside the predicate, and the scope is a hash input to the definition
   * too — so rebuilding a turn-scoped predicate WITHOUT it mints a different
   * `scorerId` and a different `definitionHash` than the first pass wrote. The
   * result is not a corrected row: it is a second, unscoped gating scorer
   * beside the original, or an `EVAL_RUN_CONFIG_CONFLICT` outright.
   */
  scope?: PredicateScope;
};

function isPredicateRow(value: unknown): value is StoredPredicateRow {
  const record = asRecord(value);
  return (
    typeof record?.passed === "boolean" &&
    asRecord(record.predicate) !== undefined
  );
}

/** Everything the derivation needs from one stored iteration. */
function deriveIterationPayload(args: {
  iteration: JudgeSecondPassIterationRow;
  mode: GradingEngineMode;
  judgeVerdict: JudgeVerdictMetadata | undefined;
  attributionVerdict: MetadataAttributionVerdictMetadata | undefined;
}): { stage: Record<string, unknown>; scores?: unknown[]; config?: unknown } {
  const { iteration, judgeVerdict, attributionVerdict } = args;
  const metadata = iteration.metadata ?? {};
  const judgeEvidence = judgeEvidenceFromVerdict(judgeVerdict);
  const metadataAttribution =
    metadataAttributionEvidenceFromVerdict(attributionVerdict);
  const predicateRows = (asArray(metadata.predicates) ?? []).filter(
    isPredicateRow,
  );
  // Derived HERE from the run's own frozen case snapshot, through the SAME
  // function the runner used on the first pass, whenever the backend served
  // the raw `authoredCase`. The backend also serves a derived `stageCase` for
  // D7's consumer; preferring our own derivation keeps stage applicability to
  // ONE implementation — the SDK's — rather than letting a backend hand-mirror
  // decide it on the second pass and the SDK decide it on the first, where a
  // disagreement between them would be invisible.
  const stageCase = iteration.authoredCase
    ? buildStageAuthoredCase({
        test: iteration.authoredCase,
        ...(iteration.authoredCase.steps
          ? { steps: iteration.authoredCase.steps }
          : {}),
        ...(iteration.authoredCase.promptTurns
          ? { turns: iteration.authoredCase.promptTurns }
          : {}),
        // THE SAME PREDICATE THE FIRST PASS USED, not a steps-shaped
        // approximation of it. `turnsNeedModel` reads `caseType` +
        // `promptTurns`; `isModelFree(steps)` returns false when `steps` is
        // ABSENT, so a legacy `widget_probe` carrying neither — which
        // `isPinnedOnly` classifies model-free on turn count alone — would be
        // called model-driven here and gain a `selection` stage the first pass
        // never derived. This post overwrites `stageResults` wholesale, so
        // that invented stage would replace the correct chain.
        caseNeedsModel: turnsNeedModel({
          caseType: iteration.authoredCase.caseType,
          promptTurns: iteration.authoredCase.promptTurns,
        }),
      })
    : iteration.stageCase;

  // AN INCOMPLETE TRACE SUPPRESSES ONLY THE STAGE KEYS.
  //
  // `traceComplete: false` means a blob this iteration references did not read
  // back, so the analyzer would be re-deriving the chain from evidence that is
  // MISSING rather than absent — and this post overwrites `stageResults` as a
  // full field, so it would replace a correct chain with a thinner one.
  //
  // It must not suppress the SCORE derivation: those rows come from stored
  // predicates and the judge's own verdict, neither of which is in the trace.
  // Dropping the whole iteration would also omit it from the fanout report,
  // which the backend reads as an incomplete fanout — so the sweep re-drives
  // it every five minutes until it exhausts MAX_ATTEMPTS and marks the run
  // failed.
  const traceUsable = iteration.traceComplete !== false;

  const stage = traceUsable
    ? buildStageMetadata({
        ...(stageCase ? { stageCase } : {}),
        ...(iteration.spans?.length ? { spans: iteration.spans } : {}),
        ...(iteration.prompts?.length ? { prompts: iteration.prompts } : {}),
        ...(iteration.messages?.length ? { messages: iteration.messages } : {}),
        ...(predicateRows.length ? { predicateResults: predicateRows } : {}),
        ...(iteration.toolSignals
          ? { toolSignals: iteration.toolSignals }
          : {}),
        ...(iteration.setupSignals
          ? { setupSignals: iteration.setupSignals }
          : {}),
        ...(judgeEvidence ? { judgeEvidence } : {}),
        ...(metadataAttribution ? { metadataAttribution } : {}),
        status: iteration.status === "failed" ? "failed" : "completed",
        ...(iteration.error ? { error: iteration.error } : {}),
      })
    : // `stageAnalyzerVersion` is suppressed WITH the rest: stamping it beside
      // no `stageResults` would claim a derivation that did not happen, and
      // since this post merges into existing metadata it would sit on top of
      // the first pass's chain and misdate it.
      {};

  // `isDualWrite` rather than `=== "dual_write"`: `enforce` writes the same
  // real rows, and the difference between the two modes is who decides the
  // verdict — which is not this pass's business either way.
  if (!isDualWrite(args.mode)) return { stage };

  const { scores, evaluationConfig } = buildHostedScoreContract({
    ...(predicateRows.length
      ? {
          predicateResults: predicateRows.map((row) => ({
            predicate: row.predicate,
            passed: row.passed,
            ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
            // Forwarded so a turn-scoped predicate rebuilds under the SAME
            // scorer identity the first pass wrote. See `StoredPredicateRow`.
            ...(row.scope ? { scope: row.scope } : {}),
          })),
        }
      : {}),
    // REDECLARE the tool-match scorer, from the authored case rather than from
    // matcher output this pass does not have.
    //
    // Forwarding `matchOptions` alone was necessary and not sufficient: the
    // definition itself is built only when the case authored expectations, and
    // that was read off `evaluation`, which this pass never supplies. So its
    // config omitted `toolCalls:match` entirely — while the backend merges
    // scores by `scorerId` and REPLACES `evaluationConfig` wholesale. The first
    // pass's tool-match row therefore survived with its definition gone: an
    // unjoinable row, a per-case `EVAL_RUN_CONFIG_CONFLICT`, and at `enforce` a
    // GATING scorer silently dropped from the verdict.
    toolMatchAuthored:
      (iteration.authoredCase?.expectedToolCalls?.length ?? 0) > 0,
    // The SAME resolved options and polarity the first pass hashed into
    // `toolCalls:match`. Omitting them would rebuild that definition under a
    // different `implementationHash` and orphan the first pass's row.
    ...(iteration.matchOptions ? { matchOptions: iteration.matchOptions } : {}),
    ...(iteration.isNegativeTest ? { isNegativeTest: true } : {}),
    ...(judgeVerdict && isFiniteNumber(judgeVerdict.threshold)
      ? { judgeVerdict }
      : {}),
  });
  return scores.length > 0
    ? { stage, scores, config: evaluationConfig }
    : { stage };
}

/** The derivation-owned fields common to both judges' write bodies. */
function stageFields(stage: Record<string, unknown>) {
  return {
    ...(asArray(stage.stageResults)
      ? { stageResults: asArray(stage.stageResults) }
      : {}),
    ...(typeof stage.firstFailedStage === "string"
      ? { firstFailedStage: stage.firstFailedStage }
      : {}),
    ...(typeof stage.failureCategory === "string"
      ? { failureCategory: stage.failureCategory }
      : {}),
    ...(stage.stageMeasurements !== undefined
      ? { stageMeasurements: stage.stageMeasurements }
      : {}),
    stageAnalyzerVersion:
      typeof stage.stageAnalyzerVersion === "number"
        ? stage.stageAnalyzerVersion
        : STAGE_ANALYZER_VERSION,
  };
}

/**
 * Grade one run's iterations, if this run's mode says to.
 *
 * THE MODE CHECK IS NOT THE ROUTE'S ALONE. Both judges' save mutations ring
 * the doorbell on every save without consulting the grading mode, so this
 * function re-resolves the mode from the run's own snapshot and stops when it
 * is not `dual_write`. `shadow` deliberately writes NOTHING here: a shadow row
 * is produced in-process by the first pass, and a second-pass write is by
 * definition a real write.
 */
export async function runJudgeSecondPass(
  runId: string,
  ports: JudgeSecondPassPorts = defaultPorts,
): Promise<JudgeSecondPassResult> {
  const emptyResult = (
    mode: GradingEngineMode,
    reason: JudgeSecondPassResult["reason"],
  ): JudgeSecondPassResult => ({
    runId,
    mode,
    noop: true,
    graded: 0,
    outcomes: [],
    metadataAttributionOutcomes: [],
    reason,
  });

  const envMode = resolveGradingEngineMode();
  if (envMode === "off") {
    return emptyResult("off", "mode_off");
  }

  let run: JudgeSecondPassRunRow;
  try {
    run = await ports.fetchRun(runId);
  } catch (error) {
    if (error instanceof JudgeStageBackendError && error.isRouteMissing) {
      logger.warn("[evals] judge second pass: backend read route unavailable", {
        runId,
      });
      return emptyResult(envMode, "backend_unavailable");
    }
    throw error;
  }

  // Through the SAME translation the first-pass and replay paths use: an absent
  // stamp is the backend's `off`, not an absent opinion. Resolving it as
  // "unconstrained" would fall through to this process's env ceiling and run
  // the REAL-WRITE second pass for a run whose frozen position was `off`,
  // contaminating the off and legacy cohorts with real score rows.
  const mode = resolveFrozenRunGradingMode(
    run.configSnapshot?.gradingEngine ?? run.gradingEngine,
  );
  // `shadow` deliberately writes NOTHING here: a shadow row is produced
  // in-process by the first pass, and a second-pass write is by definition a
  // real write. `enforce` runs exactly as `dual_write` does.
  if (!isDualWrite(mode)) {
    // Through `emptyResult`, which is the only place that knows the full shape
    // — `JudgeSecondPassResult` requires `metadataAttributionOutcomes`, and a
    // hand-built literal here silently omitted it for every `off` and `shadow`
    // run, which is most of them.
    return emptyResult(mode, mode === "off" ? "mode_off" : "mode_shadow");
  }

  const goalCompletionJobId = run.goalCompletionJobId;
  const metadataAttributionJobId = run.metadataAttributionJobId;
  if (
    goalCompletionJobId === undefined &&
    metadataAttributionJobId === undefined
  ) {
    // Without a job id the backend cannot tell this derivation from a stale
    // one, and a derivation it cannot date is one it should not accept.
    return emptyResult(mode, "no_job_id");
  }

  const derivedAt = Date.now();
  const goalCompletionOutcomes: JudgeSecondPassOutcomeEntry[] = [];
  const metadataAttributionOutcomes: JudgeSecondPassOutcomeEntry[] = [];
  let goalCompletionFailed = false;
  let metadataAttributionFailed = false;

  for (const iteration of run.iterations ?? []) {
    const judgeVerdict = readJudgeVerdict(iteration.metadata);
    const attributionVerdict = readMetadataAttributionVerdict(
      iteration.metadata,
    );
    // No verdict of either kind ⇒ no advisory evidence ⇒ nothing this pass
    // could change. Send NOTHING, and do not report the iteration: it was
    // not graded by anyone.
    if (!judgeVerdict && !attributionVerdict) continue;
    if (
      iteration.status !== undefined &&
      !DERIVABLE_STATUSES.has(iteration.status)
    ) {
      continue;
    }

    // Each judge's write is derived and posted SEPARATELY, never from one
    // shared payload — the backend applies `stageResults` /
    // `failureCategory` as a full-field overwrite (see
    // `internalApplyJudgeStageDerivation`), keyed and staleness-checked
    // against only ITS OWN job id. A single combined derivation sent to both
    // endpoints would let a stale/rejected write from one judge still land
    // via the other's successful write — e.g. a metadata-attribution job
    // superseded mid-pass could still persist `failureCategory: "metadata"`
    // through goal-completion's still-valid channel, or vice versa.
    //
    // Goal-completion's derivation therefore NEVER attaches
    // `metadataAttribution` — D7's evidence has no business riding through a
    // channel that only validates `goalCompletionJobId`. D7's derivation
    // attaches `judgeEvidence` only once THIS pass has actually confirmed
    // goal-completion's own write (or goal-completion has nothing to
    // confirm at all, i.e. no job id on this run) — so D7's write, if it
    // lands, either carries a durably-written userValue conclusion or none,
    // never one whose own write this pass just saw rejected.
    let goalCompletionConfirmed = false;

    if (
      judgeVerdict &&
      goalCompletionJobId !== undefined &&
      !goalCompletionFailed
    ) {
      const { stage, scores, config } = deriveIterationPayload({
        iteration,
        mode,
        judgeVerdict,
        attributionVerdict: undefined,
      });
      if (Object.keys(stage).length > 0) {
        const fields = stageFields(stage);
        try {
          const result = await ports.applyDerivation(iteration.iterationId, {
            goalCompletionJobId,
            judgeStageDerivedAt: derivedAt,
            ...fields,
            ...(scores ? { scores } : {}),
            ...(config !== undefined ? { evaluationConfig: config } : {}),
          });
          goalCompletionOutcomes.push({
            iterationId: iteration.iterationId,
            outcome: result.outcome,
          });
          // `stale` / `deferred` / `skipped_terminal` are normal RETURN
          // VALUES, not exceptions (see `JudgeDerivationOutcome`) — a
          // `stale` outcome means the backend refused to persist anything
          // for a job id that has moved on. Only `applied` means the
          // derivation actually landed, which is the only case D7's write
          // below may safely chain judgeEvidence from.
          goalCompletionConfirmed = result.outcome === "applied";
        } catch (error) {
          if (error instanceof JudgeStageBackendError && error.isNotFound) {
            // The row is gone. Nothing to report for it, and nothing to retry.
          } else if (
            error instanceof JudgeStageBackendError &&
            (error.isConflict || error.isRouteMissing)
          ) {
            // The run moved under us, or the surface is not deployed. Either
            // way a retry races the same way, so stop this judge's writes and
            // let the sweep decide — but D7's writes below are unaffected.
            goalCompletionFailed = true;
          } else {
            goalCompletionFailed = true;
            logger.warn("[evals] judge second pass: derivation write failed", {
              runId,
              iterationId: iteration.iterationId,
              judge: "goalCompletion",
              error: error instanceof Error ? error.name : "unknown",
            });
          }
        }
      }
    }

    if (
      attributionVerdict &&
      metadataAttributionJobId !== undefined &&
      !metadataAttributionFailed
    ) {
      const includeJudgeEvidence =
        judgeVerdict !== undefined &&
        (goalCompletionConfirmed || goalCompletionJobId === undefined);
      const { stage } = deriveIterationPayload({
        iteration,
        mode,
        judgeVerdict: includeJudgeEvidence ? judgeVerdict : undefined,
        attributionVerdict,
      });
      if (Object.keys(stage).length === 0) continue;
      const fields = stageFields(stage);
      try {
        const result = await ports.applyMetadataAttributionDerivation(
          iteration.iterationId,
          {
            metadataAttributionJobId,
            judgeStageDerivedAt: derivedAt,
            ...fields,
          },
        );
        metadataAttributionOutcomes.push({
          iterationId: iteration.iterationId,
          outcome: result.outcome,
        });
      } catch (error) {
        if (error instanceof JudgeStageBackendError && error.isNotFound) {
          // no-op, same reasoning as goal-completion's NotFound above
        } else if (
          error instanceof JudgeStageBackendError &&
          (error.isConflict || error.isRouteMissing)
        ) {
          metadataAttributionFailed = true;
        } else {
          metadataAttributionFailed = true;
          logger.warn("[evals] judge second pass: derivation write failed", {
            runId,
            iterationId: iteration.iterationId,
            judge: "metadataAttribution",
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }
  }

  const nothingGraded =
    goalCompletionOutcomes.length === 0 &&
    metadataAttributionOutcomes.length === 0;
  if (nothingGraded && !goalCompletionFailed && !metadataAttributionFailed) {
    return emptyResult(mode, "no_judge_verdicts");
  }

  if (
    goalCompletionJobId !== undefined &&
    (goalCompletionOutcomes.length > 0 || goalCompletionFailed)
  ) {
    try {
      await ports.markFanout({
        runId,
        goalCompletionJobId,
        outcomes: goalCompletionOutcomes,
        // `run.incomplete` ⇒ the FETCH stopped short of the run's tail, so
        // this report covers a subset. `markFanout` marks a fanout complete
        // when every reported outcome succeeded and cannot tell a fully
        // graded run from a partially fetched one — so a partial fetch must
        // never be allowed to close it.
        ...(goalCompletionFailed || run.incomplete ? { failed: true } : {}),
      });
    } catch (error) {
      // The sweep is the delivery guarantee: an unreported pass is retried,
      // and a retry is idempotent, so a failed report costs a minute rather
      // than a derivation.
      logger.warn("[evals] judge second pass: fanout report failed", {
        runId,
        judge: "goalCompletion",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (
    metadataAttributionJobId !== undefined &&
    (metadataAttributionOutcomes.length > 0 || metadataAttributionFailed)
  ) {
    try {
      await ports.markMetadataAttributionFanout({
        runId,
        metadataAttributionJobId,
        outcomes: metadataAttributionOutcomes,
        // Same guard, same reason — see goal-completion's report above.
        ...(metadataAttributionFailed || run.incomplete
          ? { failed: true }
          : {}),
      });
    } catch (error) {
      logger.warn("[evals] judge second pass: fanout report failed", {
        runId,
        judge: "metadataAttribution",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    runId,
    mode,
    noop: false,
    graded: goalCompletionOutcomes.length + metadataAttributionOutcomes.length,
    outcomes: goalCompletionOutcomes,
    metadataAttributionOutcomes,
  };
}
