/**
 * Groundedness — the second named advisory judge's run-detail card.
 *
 * Answers ONE question, distinct from goal completion's: is each case's
 * final answer SUPPORTED by its tool trajectory? The card leads with the
 * unsupported claims — they are the finding; the score is context.
 *
 * Deliberately simpler than `GoalCompletionCard`: v1 has no model/threshold
 * knobs (on-demand, defaults only), so the card is verdict + evidence + one
 * "Run judge" affordance. Advisory chrome throughout — nothing here is a
 * deterministic verdict, and the copy never pretends otherwise.
 */

import { CheckCircle2, Loader2, ShieldQuestion, XCircle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "./eval-surface-chrome";
import type { EvalSuiteRun } from "./types";

type GroundednessResult = NonNullable<EvalSuiteRun["groundedness"]>;

export interface GroundednessCardProps {
  run: EvalSuiteRun;
  groundedness: GroundednessResult | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRun: (force?: boolean) => void;
}

export function GroundednessCard({
  run,
  groundedness,
  pending,
  requested,
  failedGeneration,
  error,
  onRun,
}: GroundednessCardProps) {
  const busy = pending || requested;
  const hasResult = groundedness !== null && groundedness.cases.length > 0;
  const groundedCount = hasResult
    ? groundedness.cases.filter((c) => c.passed).length
    : 0;

  return (
    <div className={evalSurfaceCardClass} data-testid="groundedness-card">
      <div
        className={cn(
          evalSurfaceHeaderClass,
          "flex items-center justify-between rounded-t-2xl px-3 py-1.5",
        )}
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-tight text-foreground">
          <ShieldQuestion className="size-3.5" aria-hidden />
          Groundedness
          <span className="font-normal text-muted-foreground">advisory</span>
        </div>
        {hasResult ? (
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            data-testid="groundedness-headline"
          >
            {groundedCount}/{groundedness.cases.length} grounded
          </span>
        ) : null}
      </div>

      <div className="space-y-2 px-3 pb-3 pt-2">
        {!hasResult && !busy ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {failedGeneration && groundedness
                ? groundedness.summary
                : "Check whether each final answer's factual claims are supported by what the tools actually returned. Uses credits."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRun(failedGeneration)}
              disabled={run.status !== "completed"}
              data-testid="groundedness-run"
            >
              {failedGeneration ? "Retry" : "Run judge"}
            </Button>
          </div>
        ) : null}

        {busy ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Checking claims against tool evidence…
          </p>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {hasResult && !busy ? (
          <>
            <p className="text-xs text-muted-foreground">
              {groundedness.summary}
            </p>
            <ul className="space-y-1">
              {groundedness.cases.map((entry) => (
                <li
                  key={entry.caseKey}
                  className={cn(
                    "rounded border p-2",
                    entry.passed
                      ? "border-border/40 bg-background/40"
                      : "border-red-500/40 bg-red-500/5",
                  )}
                  data-testid="groundedness-case"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                        entry.passed
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "bg-red-500/15 text-red-700 dark:text-red-400",
                      )}
                    >
                      {entry.passed ? (
                        <CheckCircle2 className="size-3" aria-hidden />
                      ) : (
                        <XCircle className="size-3" aria-hidden />
                      )}
                      {Math.round(entry.score * 100)}%
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-xs font-medium">{entry.caseKey}</p>
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        {entry.reason}
                      </p>
                      {entry.unsupportedClaims.length > 0 ? (
                        <ul className="space-y-0.5">
                          {entry.unsupportedClaims.map((claim, index) => (
                            <li
                              key={index}
                              className="text-[11px] leading-tight text-red-600 dark:text-red-400"
                              data-testid="groundedness-unsupported-claim"
                            >
                              unsupported: “{claim}”
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRun(true)}
                data-testid="groundedness-rerun"
              >
                Re-run judge
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
