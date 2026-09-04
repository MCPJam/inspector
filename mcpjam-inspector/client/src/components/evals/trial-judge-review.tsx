/**
 * The calibration label for one trial, and the fetch behind it.
 *
 * WHAT A LABEL IS. A reviewer's own read of whether the trial satisfied the
 * request — pass, partial or fail — recorded beside the judge's. It is
 * EVIDENCE ABOUT THE JUDGE, never a verdict about the run: it changes no
 * `result`, no score row, and no gate. Enough blind labels agreeing with the
 * judge is what lets that judge decide runs at all.
 *
 * WHY A CONTAINER. `IterationDetails` has five hosts and knows only its
 * iteration; four of them have no business issuing this read. So the fetch
 * lives here, mounted only by the host that opts in, exactly as
 * `trialChainSlot` handles the same problem one component up.
 *
 * WHY NOT `useQuery`. It re-throws during render, and this query has ordinary
 * refusals — a guest, a trial from a quick run, a deployment that predates it.
 * Any of them would take the whole trial view down. A rejection is a value
 * here, and the panel simply renders without a label.
 */

import { useCallback, useEffect, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import {
  JudgeVerdictPanel,
  type JudgeCase,
  type ReviewerVerdict,
  type TrialJudgeReview as TrialJudgeReviewRow,
} from "./goal-completion-presentation";

/** The backend's refusals, in the words a reviewer needs. */
export function reviewErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("JUDGE_REVIEW_NO_VERDICT")) {
    // Also the outage case: a gating run whose judge errored carries a
    // non-answer, and there is nothing for a reviewer to agree or disagree
    // with until it has actually graded.
    return "The judge has not graded this trial yet.";
  }
  if (message.includes("JUDGE_REVIEW_NO_RUN")) {
    return "Only trials from a suite run can be labelled.";
  }
  if (message.includes("EVAL_JUDGE_REVIEW_NOTE_TOO_LONG")) {
    return "That note is too long — 500 characters at most.";
  }
  return message || "Could not record the label.";
}

export function TrialJudgeReviewPanel({
  iterationId,
  judgeCase,
  canReview = true,
}: {
  iterationId: string;
  judgeCase: JudgeCase;
  /**
   * False when the caller is known not to hold `judge.review`. Defaults TRUE:
   * with capabilities unavailable it is better to offer the control and render
   * the backend's refusal than to hide an affordance somebody does have.
   */
  canReview?: boolean;
}) {
  const convex = useConvex();
  const [review, setReview] = useState<TrialJudgeReviewRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const submitJudgeReview = useMutation(
    "evalJudgeReviews:submitJudgeReview" as never,
  ) as unknown as (args: {
    iterationId: string;
    reviewerVerdict: ReviewerVerdict;
    blind: boolean;
    note?: string;
  }) => Promise<unknown>;

  useEffect(() => {
    let cancelled = false;
    // CLEARED FIRST, synchronously. The read below is async, so without this
    // the panel keeps rendering the PREVIOUS trial's label while the new one
    // loads — and "Change label" would submit against the new `iterationId`
    // carrying provenance the reader is looking at from the old one.
    setReview(null);
    void (async () => {
      try {
        const row = await convex.query(
          "evalJudgeReviews:getIterationJudgeReview" as never,
          { iterationId } as never,
        );
        if (!cancelled) {
          setReview((row as TrialJudgeReviewRow | null) ?? null);
        }
      } catch {
        // A refused or undeployed read is "no label", not a broken page.
        if (!cancelled) setReview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, iterationId, refreshKey]);

  const onReview = useCallback(
    async (
      verdict: ReviewerVerdict,
      options: { blind: boolean; note?: string },
    ) => {
      try {
        await submitJudgeReview({
          iterationId,
          reviewerVerdict: verdict,
          // Asserted by the panel: true only when the judge's band was still
          // hidden when this verdict was chosen.
          blind: options.blind,
          ...(options.note ? { note: options.note } : {}),
        });
        setRefreshKey((n) => n + 1);
        toast.success(
          options.blind
            ? "Label recorded — it counts toward calibration"
            : "Label recorded — not blind, so it does not calibrate",
        );
      } catch (error) {
        toast.error(reviewErrorMessage(error));
      }
    },
    [iterationId, submitJudgeReview],
  );

  return (
    <JudgeVerdictPanel
      judgeCase={judgeCase}
      review={review}
      onReview={canReview ? onReview : undefined}
    />
  );
}
