/**
 * What a rubric edit would have done to a run that already finished.
 *
 * THE PROBLEM THIS SOLVES. Editing the judge's criteria changes what every
 * future verdict means, and until it is saved there is no way to find out how
 * much. A rubric that flips half a suite's verdicts and a rubric that flips
 * none look identical in a settings form. So this re-grades one finished run
 * against the DRAFT rubric and reports the difference, before the save.
 *
 * IT PERSISTS NOTHING and it SPENDS. The backend re-runs the judge, which costs
 * credits, so it is behind an explicit button and never fires on mount or on
 * save. A billing refusal is rendered as a notice rather than thrown: "we could
 * not run this" is information, not a broken dialog.
 *
 * COMPARABILITY IS THE SERVER'S CALL. A run that was never judged, or was judged
 * by an older template, has no stored band to compare against — `comparable`
 * says so and `flipped` is only ever true when it is true. The panel renders
 * the draft's own bands either way, because "here is what the new rubric says"
 * is still useful when "here is what changed" is unavailable.
 */

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import type { EvalJudgeRubric } from "./types";

type BacktestBand = "pass" | "partial" | "fail";

type BacktestCase = {
  gradingKey: string;
  iterationId: string | null;
  stored: { score: number; band: BacktestBand } | null;
  draft: { score: number; band: BacktestBand };
  flipped: boolean;
};

type BacktestResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      comparable: boolean;
      reason?: string;
      judgeTemplateVersion?: number;
      draftSuiteRubricHash: string | null;
      storedSuiteRubricHash: string | null;
      cases: BacktestCase[];
      summary: { graded: number; flips: number; storedMissing: number };
    };

/** Why a backtest could not compare, in the reader's words. */
export const INCOMPARABLE_COPY: Record<string, string> = {
  no_stored_verdict: "this run was never judged",
  template_version_differs: "this run was judged by an older judge version",
};

export function describeIncomparable(reason: string | undefined): string {
  if (!reason) return "Not comparable";
  return `Not comparable: ${INCOMPARABLE_COPY[reason] ?? reason}`;
}

export function JudgeBacktestPanel({
  suiteId,
  runId,
  runNumber,
  draftRubric,
}: {
  suiteId: string;
  runId: string;
  runNumber: number | undefined;
  /** The DRAFT rubric — what the save is about to write, not what is stored. */
  draftRubric: EvalJudgeRubric | undefined;
}) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // A RESULT BELONGS TO THE RUBRIC THAT PRODUCED IT. Editing a criterion after
  // backtesting leaves flip counts and bands on screen that were computed
  // against the previous wording — the most confidently wrong thing this panel
  // could show, since its whole purpose is to say what THIS draft would do.
  // Keyed on the criteria rather than the object so a re-render that rebuilds
  // an identical rubric does not throw away a still-valid answer.
  const rubricKey = JSON.stringify(draftRubric?.criteria ?? null);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [rubricKey]);

  const requestJudgeBacktest = useAction(
    "goalCompletionAction:requestJudgeBacktest" as never,
  ) as unknown as (args: {
    suiteId: string;
    runId: string;
    judgeRubricDraft: EvalJudgeRubric["criteria"] | null;
  }) => Promise<BacktestResult>;

  const run = async () => {
    setIsRunning(true);
    setError(null);
    try {
      const next = await requestJudgeBacktest({
        suiteId,
        runId,
        // `null`, not an empty array: the backend reads an empty list as a
        // rubric that asks nothing, and null as no rubric at all.
        judgeRubricDraft: draftRubric?.criteria ?? null,
      });
      setResult(next);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : String(caught ?? "");
      setError(
        message.includes("EVAL_JUDGE_BACKTEST_COOLDOWN")
          ? "Wait a minute before running another backtest."
          : message || "The backtest could not run.",
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border/60 p-2"
      data-testid="judge-backtest-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Judge criteria changed. See what this would have done to a finished
          run before you save it.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={isRunning}
          onClick={() => void run()}
        >
          {isRunning
            ? "Backtesting…"
            : `Backtest against run #${runNumber ?? "?"} (uses credits)`}
        </Button>
      </div>

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

      {result && result.ok === false ? (
        // A billing refusal is INFORMATION. Throwing it would take the review
        // dialog down over an optional check.
        <p className="text-[11px] text-muted-foreground">{result.reason}</p>
      ) : null}

      {result && result.ok === true ? (
        <div className="space-y-1.5">
          {result.comparable ? (
            <p className="text-[11px] text-foreground">
              {result.summary.flips} of {result.summary.graded} verdicts would
              change
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {describeIncomparable(result.reason)}
            </p>
          )}
          {result.cases.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60">
              No graded cases on that run.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {result.cases.map((row) => (
                <li
                  key={row.gradingKey}
                  className={`flex items-baseline justify-between gap-2 text-[11px] ${
                    row.flipped
                      ? "font-medium text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground"
                  }`}
                  data-backtest-case={row.gradingKey}
                  data-flipped={row.flipped ? "true" : "false"}
                >
                  <span className="min-w-0 truncate font-mono">
                    {row.gradingKey}
                  </span>
                  <span className="shrink-0">
                    {row.stored ? `${row.stored.band} → ` : ""}
                    {row.draft.band}
                    {row.stored
                      ? ` · Δ ${(row.draft.score - row.stored.score).toFixed(2)}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
