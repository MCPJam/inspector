/**
 * "Did it accomplish the goal?" — in a sentence, with its score and its role.
 *
 * This is the first grader a case has, and on the observe-first flow it is the
 * only one until a run produces evidence to harden from. So it says what it
 * decided in words, and it says what that decides: an advisory judge does NOT
 * move the trial's verdict, and the header keeps saying what the checks said.
 *
 * The honest states matter as much as the answer. A quick run can never be
 * judged — every judge surface is keyed by `suiteRunId`, and a quick run has
 * none — so rather than showing "not run" and letting a reader conclude the
 * judge is broken, it names the reason and points at the control that works.
 */

import { Gavel } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";

export type JudgeAnswerState =
  | { kind: "scored"; judgeCase: JudgeCase; threshold: number; gating: boolean }
  | { kind: "judging" }
  | { kind: "failed" }
  | { kind: "notRun" }
  | { kind: "quickRun" }
  | { kind: "suiteOff" }
  | { kind: "skipped" }
  /** A reviewer is labelling this trial and has not revealed the verdict. */
  | { kind: "withheld" };

/** The band a score falls in, in the words a reader would use. */
function answerWord(passed: boolean, score: number, threshold: number): string {
  if (passed) return "Yes";
  // The backend's own partial floor: a near miss is not the same claim as a
  // flat no, and calling it one would misreport what the judge said.
  return score >= threshold * 0.6 ? "Partly" : "No";
}

export function JudgeAnswerRow({
  state,
  onRetry,
  onOpenSuiteSettings,
  children,
}: {
  state: JudgeAnswerState;
  onRetry?: () => void;
  onOpenSuiteSettings?: () => void;
  /** The existing verdict/review panel, hosted as this row's body. */
  children?: React.ReactNode;
}) {
  return (
    <div
      data-testid="judge-answer-row"
      data-judge-state={state.kind}
      className="space-y-1.5 rounded-md border border-border/60 bg-background/40 px-2.5 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Gavel className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">
          Did it accomplish the goal?
        </span>
        <Body
          state={state}
          onRetry={onRetry}
          onOpenSuiteSettings={onOpenSuiteSettings}
        />
      </div>
      {state.kind === "scored" || state.kind === "withheld" ? children : null}
    </div>
  );
}

function Body({
  state,
  onRetry,
  onOpenSuiteSettings,
}: {
  state: JudgeAnswerState;
  onRetry?: () => void;
  onOpenSuiteSettings?: () => void;
}) {
  if (state.kind === "scored") {
    const { judgeCase, threshold, gating } = state;
    if (judgeCase.status === "error" || judgeCase.status === "skipped") {
      return (
        <>
          <span className="text-xs text-muted-foreground">
            The judge could not grade this trial
          </span>
          {onRetry ? <RetryButton onRetry={onRetry} /> : null}
        </>
      );
    }
    const word = answerWord(judgeCase.passed, judgeCase.score, threshold);
    return (
      <>
        <span
          className={cn(
            "text-xs font-semibold",
            judgeCase.passed ? "text-success" : "text-muted-foreground",
          )}
          data-testid="judge-answer-word"
        >
          {word}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {judgeCase.score.toFixed(2)}
          {judgeCase.passed ? " ≥ " : " < "}
          {threshold.toFixed(2)}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {gating ? "Gate" : "Advisory — does not change the result"}
        </span>
      </>
    );
  }
  if (state.kind === "judging") {
    return <span className="text-xs text-muted-foreground">Judging…</span>;
  }
  if (state.kind === "failed") {
    return (
      <>
        <span className="text-xs text-muted-foreground">
          The judge could not grade this trial
        </span>
        {onRetry ? <RetryButton onRetry={onRetry} /> : null}
      </>
    );
  }
  if (state.kind === "withheld") {
    return (
      <span className="text-xs text-muted-foreground">
        Hidden until you label this trial
      </span>
    );
  }
  if (state.kind === "quickRun") {
    return (
      <span className="text-xs text-muted-foreground">
        Quick runs are not graded — use Run test
      </span>
    );
  }
  if (state.kind === "suiteOff") {
    return (
      <>
        <span className="text-xs text-muted-foreground">
          Judge is off for this suite
        </span>
        {onOpenSuiteSettings ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={onOpenSuiteSettings}
          >
            Edit in suite settings
          </Button>
        ) : null}
      </>
    );
  }
  if (state.kind === "skipped") {
    return (
      <span className="text-xs text-muted-foreground">
        Skipped for this case
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      Not run for this trial
    </span>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 text-[11px] text-muted-foreground"
      onClick={onRetry}
    >
      Retry
    </Button>
  );
}

/**
 * Which state a trial's judge is in.
 *
 * Pure so the states are testable without a run: the editor holds the live
 * data, this decides what the row says about it.
 */
export function judgeAnswerState(input: {
  /** Withhold the answer while a blind label is being taken. */
  hidden?: boolean;
  /** `compare:` batches are quick runs; they carry no `suiteRunId`. */
  isQuickRun: boolean;
  judgeEnabledOnSuite: boolean;
  skippedForCase: boolean;
  runJudgeStatus: "pending" | "completed" | "failed" | undefined;
  judgeCase: JudgeCase | null | undefined;
  threshold: number;
  gating: boolean;
}): JudgeAnswerState {
  // Fails closed and FIRST: a label recorded as blind beside a visible
  // verdict is not calibration data, and calibration gates other builds.
  if (input.hidden) return { kind: "withheld" };
  if (input.skippedForCase) return { kind: "skipped" };
  if (!input.judgeEnabledOnSuite) return { kind: "suiteOff" };
  if (input.isQuickRun) return { kind: "quickRun" };
  if (input.judgeCase) {
    return {
      kind: "scored",
      judgeCase: input.judgeCase,
      threshold: input.threshold,
      gating: input.gating,
    };
  }
  if (input.runJudgeStatus === "pending") return { kind: "judging" };
  if (input.runJudgeStatus === "failed") return { kind: "failed" };
  return { kind: "notRun" };
}
