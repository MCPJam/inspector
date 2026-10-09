import type { SwarmFundingPreviewState } from "@/hooks/use-swarm-funding-preview";
import {
  creditFundingExplanation,
  fundingHeadline,
  fundingSplitOf,
} from "@/components/swarms/swarm-funding-plan";

/**
 * The sponsored split of a launch, shown on Confirm above the launch button:
 * "5 sponsored conversations · 10 use org credits", why some use credits, and a
 * notice when a launch stopped because the split moved.
 *
 * It says what the preview says and no more. Sponsored capacity is MCPJam's and
 * can run out mid-run, and which models and environments qualify is decided by
 * the backend, so nothing here calls anything free or promises completion.
 * Renders nothing while loading, when sponsorship does not apply, or when the
 * preview failed: the launch is then exactly what it was before this existed.
 */
export function SwarmFundingSummary({
  state,
  requestedRuns,
  pendingGoals,
  notice,
}: {
  state: SwarmFundingPreviewState;
  /** Runs the preview was asked about; a preview answering fewer is ignored. */
  requestedRuns: number;
  /** New goals not created yet, so not covered by the preview. */
  pendingGoals: number;
  /** Set when a launch stopped for review or a 409 moved the split. */
  notice: string | null;
}) {
  const split =
    state.status === "ready"
      ? fundingSplitOf(state.preview, requestedRuns)
      : null;
  if (!split && !notice) return null;
  const explanation =
    state.status === "ready" && split
      ? creditFundingExplanation(state.preview, split)
      : null;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm"
      data-testid="new-swarm-funding"
    >
      {split ? (
        <p className="font-medium" data-testid="new-swarm-funding-split">
          {fundingHeadline(split)}
        </p>
      ) : null}
      {explanation ? (
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="new-swarm-funding-explanation"
        >
          {explanation}
        </p>
      ) : null}
      {split && pendingGoals > 0 ? (
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="new-swarm-funding-pending"
        >
          {pendingGoals === 1
            ? "This covers your existing goals. The new goal's conversations are placed when it is created, and you will see the split before anything runs."
            : `This covers your existing goals. The ${pendingGoals} new goals' conversations are placed when they are created, and you will see the split before anything runs.`}
        </p>
      ) : null}
      {notice ? (
        <p
          role="alert"
          className="text-xs leading-relaxed text-foreground"
          data-testid="new-swarm-funding-notice"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
