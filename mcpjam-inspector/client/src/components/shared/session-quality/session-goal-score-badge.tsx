import { formatScore, ScoreBadge } from "./judge-presentation";

/**
 * Per-session goal-completion judge badge, shared by the Swarms sessions list,
 * the run matrix, and the shared-chat thread list. Lives here (not in
 * SwarmsTab) so surfaces rendered *inside* SwarmsTab's subtree can import it
 * without an import cycle.
 *
 * States: completed → "82% + meets/below" (reusing the shared ScoreBadge);
 * running → "judging…"; failed → "judge unavailable" (never silently hidden —
 * the session viewer offers Retry); absent/malformed → nothing.
 */

// The backend denormalizes a WIDE `goalScore` subset onto sessions/threads.
// Both `JourneySessionRow["goalScore"]` (swarm-api) and
// `SharedChatThread["goalScore"]` (useSharedChatThreads) are structurally this.
export type SessionGoalScoreLike = {
  status?: string;
  score?: number;
  passed?: boolean;
  threshold?: number;
  reason?: string;
  error?: string;
};

const GOAL_SCORE_STATUSES = ["running", "completed", "failed"] as const;
export type GoalScoreStatus = (typeof GOAL_SCORE_STATUSES)[number];

/**
 * Validate the status enum + score before rendering so a malformed record
 * degrades to "no badge" instead of a corrupt verdict.
 */
export function toSessionGoalScore(
  raw: SessionGoalScoreLike | undefined,
): (SessionGoalScoreLike & { status: GoalScoreStatus }) | undefined {
  if (!raw) return undefined;
  if (!(GOAL_SCORE_STATUSES as readonly string[]).includes(raw.status ?? "")) {
    return undefined;
  }
  const status = raw.status as GoalScoreStatus;
  // A completed verdict must carry BOTH a finite score and a boolean passed —
  // a malformed `passed` must not silently render as "below threshold".
  if (
    status === "completed" &&
    (!Number.isFinite(raw.score) || typeof raw.passed !== "boolean")
  ) {
    return undefined;
  }
  return { ...raw, status };
}

export function SessionGoalScoreBadge({
  goalScore,
}: {
  goalScore: SessionGoalScoreLike | undefined;
}) {
  const gs = toSessionGoalScore(goalScore);
  if (!gs) return null;
  if (gs.status === "running") {
    return (
      <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        judging…
      </span>
    );
  }
  if (gs.status === "failed") {
    return (
      <span
        className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
        title={gs.error ?? "Judge run failed — open the session to retry"}
      >
        judge unavailable
      </span>
    );
  }
  // completed: reuse the shared ScoreBadge so the pass/fail chrome stays
  // identical to the evals verdict, prefixed with the compact score.
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground"
      title={gs.reason ?? undefined}
    >
      {formatScore(gs.score ?? NaN)}
      <ScoreBadge passed={gs.passed ?? false} />
    </span>
  );
}
