import { useState } from "react";
import { ChevronDown, Gavel, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalSuiteRun } from "./types";
import type { RunCaseGroup } from "./run-case-groups";

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
 * The judge prefixes objective-mode reasons with "no rubric:" — internal
 * jargon for the lower-confidence (≤85%) mode used when a case has neither an
 * Expected Output nor derivable assertions. Parse it out so the UI can show a
 * friendly "no expected output" tag and a clean reason instead of leaking the
 * prefix. (Most cases now derive a rubric from their assertions, so this is
 * rare — but when it appears it shouldn't read as gibberish.)
 */
const NO_RUBRIC_PREFIX = /^\s*no rubric\s*[:—-]\s*/i;
export function parseJudgeReason(reason: string | undefined): {
  noRubric: boolean;
  text: string;
} {
  const raw = reason ?? "";
  return {
    noRubric: NO_RUBRIC_PREFIX.test(raw),
    text: raw.replace(NO_RUBRIC_PREFIX, "").trim(),
  };
}

export function formatScore(score: number): string {
  // Don't route the score through clampThreshold: its NaN→DEFAULT_THRESHOLD
  // fallback is right for the threshold input but would render a corrupt/NaN
  // score as "70%" (the pass cutoff). Show a neutral dash instead, and clamp
  // finite scores into [0,1].
  if (!Number.isFinite(score)) {
    return "—";
  }
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

export function ScoreBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        passed
          ? "bg-success/50 text-foreground"
          : "bg-warning/50 text-foreground",
      )}
    >
      {passed ? "meets goal" : "below threshold"}
    </span>
  );
}

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
 * Resolve the judge verdict for a single iteration shown in the case drill-in,
 * by joining the iteration's `suiteRunId` + snapshot `caseKey` against the
 * loaded runs' `goalCompletion`. Returns null when the iteration's run wasn't
 * judged or the iteration lacks the join keys.
 */
export function resolveIterationJudge(
  iteration:
    | {
        suiteRunId?: string | null;
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
  return (
    run?.goalCompletion?.cases.find((c) => c.caseKey === caseKey) ?? null
  );
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
export function JudgeVerdictPanel({ judgeCase }: { judgeCase: JudgeCase }) {
  const { noRubric, text: reason } = parseJudgeReason(judgeCase.reason);
  const canExpand = Boolean(reason);
  const [expanded, setExpanded] = useState(false);

  const header = (
    <>
      <Gavel className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium uppercase tracking-wide text-muted-foreground">
        Judge · advisory
      </span>
      <span className="font-semibold tabular-nums text-foreground">
        {formatScore(judgeCase.score)}
      </span>
      <ScoreBadge passed={judgeCase.passed} />
      {noRubric ? (
        <span
          className="shrink-0 rounded-sm bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          title="No expected output or assertions to grade against — graded loosely against the request, score capped at 85%. Add assertions or an Expected Output for stricter grading."
        >
          no expected output
        </span>
      ) : null}
      {canExpand && !expanded ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {reason}
        </span>
      ) : null}
      {canExpand ? (
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      ) : null}
    </>
  );

  return (
    <div className="shrink-0 rounded-lg border border-border/50 bg-muted/15 text-xs">
      {canExpand ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/25"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse judge reason" : "Expand judge reason"
          }
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{header}</div>
      )}
      {canExpand && expanded ? (
        <div
          className="border-t border-border/40 px-3 py-2 text-muted-foreground leading-relaxed whitespace-pre-wrap break-words"
        >
          {reason}
        </div>
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
