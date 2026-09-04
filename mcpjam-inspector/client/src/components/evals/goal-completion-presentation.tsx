import { useState } from "react";
import { Gavel, Wrench } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { EvalSuiteRun } from "./types";
import type { RunCaseGroup } from "./run-case-groups";
import {
  formatScore,
  parseJudgeReason,
  JudgeVerdictCard,
  ScoreBadge,
} from "@/components/shared/session-quality/judge-presentation";

// Generic judge presentation now lives in the product-neutral module (the
// Swarms session viewer renders the same backend judge's verdicts). Re-export
// under the historical names so every eval call site keeps compiling.
export {
  formatScore,
  parseJudgeReason,
  ScoreBadge,
} from "@/components/shared/session-quality/judge-presentation";

/** Per-(case×host) server-quality workflow finding, keyed by caseKey on a run. */
export type WorkflowInsight = NonNullable<
  EvalSuiteRun["serverQuality"]
>["workflowInsights"][number];

/**
 * Shared presentation for the advisory LLM-as-judge (goal completion) verdict.
 * Lives apart from `goal-completion-card.tsx` so both the detailed card and the
 * inline per-case badge in the run case list render identical scores/badges and
 * apply the SAME disagreement logic — there is one source of truth for "what a
 * judge verdict looks like" and "when the judge disagrees with pass/fail".
 */

export type JudgeCase = NonNullable<EvalSuiteRun["goalCompletion"]>["cases"][number];

/**
 * Build a `caseKey → judge verdict` map from a run's goal-completion result.
 * Keyed by the same `testCaseSnapshot.caseKey` the backend grades by (see
 * `iterationCaseKey` in goalCompletionGeneration.ts), so it joins to a case
 * row via `caseKeyForGroup` below. Returns `null` when there is nothing graded
 * so callers can cheaply skip rendering.
 */
export function buildJudgeCaseMap(
  goalCompletion: EvalSuiteRun["goalCompletion"] | null | undefined,
): Map<string, JudgeCase> | null {
  if (!goalCompletion || goalCompletion.cases.length === 0) {
    return null;
  }
  const map = new Map<string, JudgeCase>();
  for (const c of goalCompletion.cases) {
    if (c.caseKey && !map.has(c.caseKey)) {
      map.set(c.caseKey, c);
    }
  }
  return map;
}

/**
 * The judge `caseKey` for a grouped case row. The judge keys on the snapshot's
 * `caseKey` (NOT `RunCaseGroup.key`, which is `testCaseId`/`title:` and would
 * mis-join), so read it off the group's first iteration that carries one.
 */
export function caseKeyForGroup(group: RunCaseGroup): string | null {
  for (const iter of group.iterations) {
    const caseKey = iter.testCaseSnapshot?.caseKey;
    if (caseKey) {
      return caseKey;
    }
  }
  return null;
}

/**
 * Build a `runId → (caseKey → judge verdict)` index across multiple runs, for
 * the cross-host matrix where every (case, host) cell belongs to a DIFFERENT
 * run (its host's latest run). Each run carries its own `goalCompletion`, so a
 * cell resolves its verdict from its own run — not a single run-wide map.
 */
export function buildJudgeByRunAndCaseKey(
  runs: Array<Pick<EvalSuiteRun, "_id" | "goalCompletion">>,
): Map<string, Map<string, JudgeCase>> {
  const byRun = new Map<string, Map<string, JudgeCase>>();
  for (const run of runs) {
    const goalCompletion = run.goalCompletion;
    if (!goalCompletion || goalCompletion.cases.length === 0) {
      continue;
    }
    const byCase = new Map<string, JudgeCase>();
    for (const c of goalCompletion.cases) {
      if (c.caseKey && !byCase.has(c.caseKey)) {
        byCase.set(c.caseKey, c);
      }
    }
    if (byCase.size > 0) {
      byRun.set(run._id, byCase);
    }
  }
  return byRun;
}

/**
 * Resolve the advisory judge verdict for a matrix cell from its iterations.
 * A cell's iterations all belong to the same winning run and the same case, so
 * the first one carrying both a `suiteRunId` and a snapshot `caseKey` pins the
 * verdict. Returns undefined when that run wasn't judged.
 */
export function resolveCellJudge(
  cellIterations: Array<{
    suiteRunId?: string | null;
    testCaseSnapshot?: { caseKey?: string } | null;
  }>,
  judgeByRunAndCaseKey: Map<string, Map<string, JudgeCase>> | null | undefined,
): JudgeCase | undefined {
  if (!judgeByRunAndCaseKey) {
    return undefined;
  }
  for (const iter of cellIterations) {
    const runId = iter.suiteRunId ?? undefined;
    const caseKey = iter.testCaseSnapshot?.caseKey;
    if (runId && caseKey) {
      const found = judgeByRunAndCaseKey.get(runId)?.get(caseKey);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Build a `runId → (caseKey → workflow finding)` index across runs — the
 * server-quality counterpart to {@link buildJudgeByRunAndCaseKey}. Workflow
 * insights are per-(case×host) (keyed by `caseKey` on each run's
 * `serverQuality`), so a matrix cell resolves its finding from its own run.
 */
export function buildWorkflowByRunAndCaseKey(
  runs: Array<Pick<EvalSuiteRun, "_id" | "serverQuality">>,
): Map<string, Map<string, WorkflowInsight>> {
  const byRun = new Map<string, Map<string, WorkflowInsight>>();
  for (const run of runs) {
    const insights = run.serverQuality?.workflowInsights;
    if (!insights || insights.length === 0) {
      continue;
    }
    const byCase = new Map<string, WorkflowInsight>();
    for (const w of insights) {
      if (w.caseKey && !byCase.has(w.caseKey)) {
        byCase.set(w.caseKey, w);
      }
    }
    if (byCase.size > 0) {
      byRun.set(run._id, byCase);
    }
  }
  return byRun;
}

/** Resolve a matrix cell's workflow finding from its iterations (run + caseKey). */
export function resolveCellWorkflow(
  cellIterations: Array<{
    suiteRunId?: string | null;
    testCaseSnapshot?: { caseKey?: string } | null;
  }>,
  workflowByRunAndCaseKey:
    | Map<string, Map<string, WorkflowInsight>>
    | null
    | undefined,
): WorkflowInsight | undefined {
  if (!workflowByRunAndCaseKey) {
    return undefined;
  }
  for (const iter of cellIterations) {
    const runId = iter.suiteRunId ?? undefined;
    const caseKey = iter.testCaseSnapshot?.caseKey;
    if (runId && caseKey) {
      const found = workflowByRunAndCaseKey.get(runId)?.get(caseKey);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the judge verdict for a single iteration shown in the case drill-in.
 *
 * THREE JOIN KEYS, MOST SPECIFIC FIRST, and the order is the correctness. A
 * case that runs more than once — every case under verdict policy v2 — produces
 * one verdict per trial, and `caseKey` names the CASE rather than the trial. So
 * a `caseKey` join returns whichever trial's verdict happens to be first in the
 * array and attributes it to the trial the reader is looking at. That is not a
 * missing verdict; it is the wrong one, shown confidently.
 *
 *   1. `iterationId` — the backend resolved this verdict to this trial.
 *   2. `gradingKey` — `${caseKey}#${iterationNumber}`, the trial's own key.
 *   3. `caseKey` — the LEGACY fallback, correct only when a case ran once.
 *      Kept for runs judged before the keys existed, which is the only
 *      population it can still be wrong for and the only one it can serve.
 */
export function resolveIterationJudge(
  iteration:
    | {
        _id?: string;
        suiteRunId?: string | null;
        iterationNumber?: number;
        testCaseSnapshot?: { caseKey?: string } | null;
      }
    | null
    | undefined,
  runs: Array<Pick<EvalSuiteRun, "_id" | "goalCompletion">>,
): JudgeCase | null {
  const runId = iteration?.suiteRunId;
  const caseKey = iteration?.testCaseSnapshot?.caseKey;
  if (!runId || !caseKey) {
    return null;
  }
  const run = runs.find((r) => r._id === runId);
  const cases = run?.goalCompletion?.cases;
  if (!cases) return null;

  const iterationId = iteration?._id;
  if (iterationId) {
    const byIteration = cases.find((c) => c.iterationId === iterationId);
    if (byIteration) return byIteration;
  }
  if (iteration?.iterationNumber !== undefined) {
    const gradingKey = `${caseKey}#${iteration.iterationNumber}`;
    const byGradingKey = cases.find((c) => c.gradingKey === gradingKey);
    if (byGradingKey) return byGradingKey;
  }
  // Legacy only, and CHECKED rather than assumed. Reaching here on a run whose
  // cases do carry a new key does not mean the run is old; it means this trial
  // has no verdict in it — the judge errored on it, or has not reached it yet.
  // Falling back to `caseKey` there would hand back a SIBLING trial's verdict,
  // which is the exact confusion the join order exists to prevent. No verdict
  // is the honest answer.
  const keyedByTrial = cases.some(
    (c) => c.iterationId !== undefined || c.gradingKey !== undefined,
  );
  if (keyedByTrial) return null;
  return cases.find((c) => c.caseKey === caseKey) ?? null;
}

/**
 * Compact, always-visible advisory judge verdict for the case drill-in. Sits
 * directly under the Steps/Chat/Results/Trace/App/Raw tab row so it's seen on
 * every tab (not buried in one), matching how Braintrust/LangSmith keep the
 * score visible in the trace header. One line: gavel + score + verdict badge +
 * a one-line preview; click to expand the full reason. The table carries the
 * compact score, the rail carries the run summary + disagreements, and this is
 * the per-case home.
 */
export function JudgeVerdictPanel({
  judgeCase,
  review,
  onReview,
}: {
  judgeCase: JudgeCase;
  /** An existing calibration label for this trial, when there is one. */
  review?: TrialJudgeReview | null;
  /**
   * Record a calibration label. Absent means labelling is not offered here —
   * a quick-run trial, or a caller without the permission.
   *
   * `blind` is ASSERTED by this component: it passes `true` only when the
   * judge's band was still hidden at the moment the label was chosen. The
   * backend counts only blind rows toward the agreement rate, so a lie here
   * would inflate a calibration that gates other people's builds.
   */
  onReview?: (
    verdict: ReviewerVerdict,
    options: { blind: boolean; note?: string },
  ) => void | Promise<void>;
}) {
  // The blind protocol. The judge's band starts HIDDEN and stays hidden until
  // somebody asks for it — a label chosen while looking at the judge's answer
  // measures anchoring, not judgement, which is why the backend refuses to
  // count it. Revealing is allowed and honest; it just does not calibrate.
  const [revealed, setRevealed] = useState(
    review !== null && review !== undefined,
  );
  const canLabel = onReview !== undefined;

  return (
    <div className="space-y-2">
      {canLabel && !review ? (
        <TrialReviewControl
          revealed={revealed}
          onSubmit={(verdict, note) =>
            onReview?.(verdict, { blind: !revealed, ...(note ? { note } : {}) })
          }
          onReveal={() => setRevealed(true)}
        />
      ) : null}
      {review ? (
        <TrialReviewProvenance
          review={review}
          judgeCase={judgeCase}
          onChange={
            canLabel
              ? (verdict, note) =>
                  onReview?.(verdict, {
                    // A CHANGED label is never blind: the reader has seen the
                    // judge's verdict by now, on this very panel.
                    blind: false,
                    ...(note ? { note } : {}),
                  })
              : undefined
          }
        />
      ) : null}
      {revealed || !canLabel ? (
        // Thin adapter: the card itself is product-neutral (shared with the
        // Swarms session viewer); this keeps the historical eval-shaped
        // signature.
        <JudgeVerdictCard
          verdict={{
            score: judgeCase.score,
            passed: judgeCase.passed,
            reason: judgeCase.reason,
          }}
        />
      ) : null}
    </div>
  );
}

/** A reviewer's own read of a trial. Never a verdict override. */
export type ReviewerVerdict = "pass" | "partial" | "fail";

/** What `evalJudgeReviews:getIterationJudgeReview` returns for one trial. */
export type TrialJudgeReview = {
  reviewerVerdict: ReviewerVerdict;
  judgeVerdict: string;
  reviewerUserId?: string;
  note: string | null;
  blind: boolean;
  createdAt: number;
};

const REVIEWER_VERDICTS: ReviewerVerdict[] = ["pass", "partial", "fail"];

/**
 * Label first, reveal second.
 *
 * The order on screen IS the protocol: the control that records a judgement
 * comes before the button that shows the judge's, so the default path produces
 * a blind label. Revealing first is allowed and says so — an honest
 * non-calibrating label beats a reader who quietly agrees with a number they
 * already saw.
 */
function TrialReviewControl({
  revealed,
  onSubmit,
  onReveal,
}: {
  revealed: boolean;
  onSubmit: (verdict: ReviewerVerdict, note: string) => void;
  onReveal: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div
      className="space-y-1.5 rounded-lg border border-border/50 p-2 text-xs"
      data-testid="trial-review-control"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Label this trial</span>
        {revealed ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={onReveal}
          >
            Reveal judge verdict
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {REVIEWER_VERDICTS.map((verdict) => (
          <Button
            key={verdict}
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-[11px] capitalize"
            onClick={() => onSubmit(verdict, note.trim())}
          >
            {verdict}
          </Button>
        ))}
      </div>
      <input
        className="h-7 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground"
        value={note}
        placeholder="Optional note"
        aria-label="Reviewer note"
        onChange={(event) => setNote(event.target.value)}
      />
      {revealed ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="trial-review-not-blind"
        >
          Not blind — won&apos;t count toward calibration.
        </p>
      ) : null}
    </div>
  );
}

/** Both readings side by side, once a label exists. */
function TrialReviewProvenance({
  review,
  judgeCase,
  onChange,
}: {
  review: TrialJudgeReview;
  judgeCase: JudgeCase;
  onChange?: (verdict: ReviewerVerdict, note: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  return (
    <div
      className="space-y-1.5 rounded-lg border border-border/50 p-2 text-xs"
      data-testid="trial-review-provenance"
    >
      <p className="text-muted-foreground">
        Judge: {review.judgeVerdict} ({formatScore(judgeCase.score)}) ·
        Reviewer: {review.reviewerVerdict}
        {review.note ? ` — ${review.note}` : ""}
      </p>
      {review.blind ? null : (
        <p className="text-[11px] text-muted-foreground/60">
          Not blind — not counted toward calibration.
        </p>
      )}
      {onChange ? (
        changing ? (
          <TrialReviewControl
            // A change is made with the judge's verdict already on screen, so
            // it can never be blind — see `onReview` above.
            revealed
            onSubmit={(verdict, note) => {
              setChanging(false);
              onChange(verdict, note);
            }}
            onReveal={() => {}}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => setChanging(true)}
          >
            Change label
          </Button>
        )
      ) : null}
    </div>
  );
}

/**
 * The deterministic case verdict for a grouped row: `true` (all iterations
 * passed), `false` (any failed), or `null` (incomplete — pending iterations, or
 * nothing ran). `null` suppresses the disagreement marker since there is no
 * settled verdict to disagree with.
 */
export function deterministicCasePassed(group: RunCaseGroup): boolean | null {
  if (group.total === 0 || group.pending > 0) {
    return null;
  }
  return group.failed === 0 && group.passed > 0;
}

/**
 * Whether the advisory judge verdict disagrees with the deterministic pass/fail
 * — the highest-signal moment to surface (judge says "meets goal" on a failed
 * case, or "below threshold" on a passed one). Single source of truth for both
 * the card and the inline badge. Returns false when either side is unsettled.
 */
export function judgeDisagreesWithVerdict(
  deterministicPassed: boolean | null,
  judgePassed: boolean | undefined,
): boolean {
  if (deterministicPassed === null || judgePassed === undefined) {
    return false;
  }
  return deterministicPassed !== judgePassed;
}

/**
 * Compact advisory judge chip for a case row / matrix cell: a gavel + the score
 * only, color-coded (green = meets goal, amber = below threshold), with the
 * verdict word and one-line reason in the tooltip and a `≠` marker when it
 * disagrees with the deterministic verdict.
 *
 * Deliberately minimal — the score is the scan signal; the words and reasoning
 * live in the tooltip (and the drill-in), matching how Braintrust/LangSmith
 * keep the grid to one glanceable number per cell. Advisory tone: it sits
 * beside, never replaces, the real pass/fail.
 */
export function InlineJudgeBadge({
  judgeCase,
  disagrees,
}: {
  judgeCase: JudgeCase;
  disagrees: boolean;
}) {
  const reason = judgeCase.reason?.trim();
  const verdict = judgeCase.passed ? "meets goal" : "below threshold";
  const title = [
    disagrees
      ? `Judge disagrees with the deterministic pass/fail (judge: ${verdict})`
      : `Judge: ${verdict}`,
    reason,
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <span
      title={title}
      aria-label={`Judge ${verdict}, ${formatScore(judgeCase.score)}${
        disagrees ? ", disagrees with pass/fail" : ""
      }`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
        judgeCase.passed
          ? "bg-success/50 text-foreground"
          : "bg-warning/50 text-foreground",
        disagrees && "ring-1 ring-warning",
      )}
    >
      <Gavel className="size-2.5 opacity-70" aria-hidden />
      <span>{formatScore(judgeCase.score)}</span>
      {disagrees ? <span aria-hidden>≠</span> : null}
    </span>
  );
}

const WORKFLOW_TONE: Record<WorkflowInsight["efficiency"], string> = {
  optimal: "text-success",
  acceptable: "text-muted-foreground",
  inefficient: "text-amber-600 dark:text-amber-400",
  excessive: "text-destructive",
};

/**
 * Expanded per-(case×host) insight for a matrix cell: the advisory judge
 * verdict + reason and the server-quality workflow finding, plus a link into
 * the trajectory. This is what makes the matrix self-explaining — the rail's
 * per-case content lives here, in the cell it describes, across every host.
 */
export function CellInsightPanel({
  judgeCase,
  workflowInsight,
  onOpenTrace,
}: {
  judgeCase?: JudgeCase;
  workflowInsight?: WorkflowInsight;
  onOpenTrace?: () => void;
}) {
  const reason = judgeCase ? parseJudgeReason(judgeCase.reason) : null;
  return (
    // Stop propagation so interacting with the panel doesn't trigger the
    // cell's drill-in click.
    <div
      className="space-y-2 border-t border-border/40 px-3 py-2 text-left text-[11px]"
      onClick={(event) => event.stopPropagation()}
    >
      {judgeCase ? (
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Gavel className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium uppercase tracking-wide text-muted-foreground">
              Judge
            </span>
            <span className="font-semibold tabular-nums text-foreground">
              {formatScore(judgeCase.score)}
            </span>
            <ScoreBadge passed={judgeCase.passed} />
            {reason?.noRubric ? (
              <span
                className="rounded-sm bg-muted/70 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                title="No expected output or assertions — graded loosely against the request, capped at 85%."
              >
                no expected output
              </span>
            ) : null}
          </div>
          {reason?.text ? (
            <p className="mt-1 leading-snug text-muted-foreground">
              {reason.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {workflowInsight ? (
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Wrench className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium uppercase tracking-wide text-muted-foreground">
              Workflow
            </span>
            <span
              className={cn(
                "font-medium uppercase tracking-wide",
                WORKFLOW_TONE[workflowInsight.efficiency],
              )}
            >
              {workflowInsight.efficiency}
            </span>
          </div>
          {workflowInsight.issues.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-snug text-muted-foreground">
              {workflowInsight.issues.map((issue, i) => (
                <li key={`issue-${i}`}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {workflowInsight.suggestions.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-snug text-muted-foreground/80">
              {workflowInsight.suggestions.map((s, i) => (
                <li key={`sugg-${i}`}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {onOpenTrace ? (
        <button
          type="button"
          onClick={onOpenTrace}
          className="font-medium text-primary hover:underline"
        >
          View trace →
        </button>
      ) : null}
    </div>
  );
}
