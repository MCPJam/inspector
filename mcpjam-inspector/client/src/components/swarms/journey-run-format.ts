import { formatScore } from "@/components/shared/session-quality/judge-presentation";
import type { GoalScoreRollup, JourneyRun } from "@/lib/swarm-api";

// ── run status treatment ─────────────────────────────────────────────────────
export function runStatusChipClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "partial":
    case "rate_limited":
      return "bg-muted text-muted-foreground";
    case "failed":
      return "bg-red-500/10 text-red-700 dark:text-red-400";
    case "stale":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-foreground"; // running
  }
}

export function formatJourneyRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** `· goal 78% avg (4 judged)` — used on journey run rows. */
export function goalScoreAvgLabel(
  rollup: GoalScoreRollup | undefined,
): string | null {
  if (!rollup || rollup.gradedCount === 0 || rollup.avgScore === null) {
    return null;
  }
  return `goal ${formatScore(rollup.avgScore)} avg (${rollup.gradedCount} judged)`;
}

export function runSummaryLine(r: JourneyRun): string {
  const parts = [
    `${r.summary.succeeded}/${r.summary.total} sessions ok`,
    r.summary.failed > 0 ? `${r.summary.failed} failed` : null,
    r.summary.rateLimited > 0 ? `${r.summary.rateLimited} rate-limited` : null,
    goalScoreAvgLabel(r.goalScoreSummary),
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Stable run name: #1 is the journey's first-ever run. `index` is the run's
 * position in the newest-first list; `runCount` the journey's lifetime total
 * (rollup), so the number doesn't shift when new runs land.
 */
export function runNumberLabel(runCount: number, index: number): string {
  const n = runCount - index;
  return n > 0 ? `Run #${n}` : "Run";
}
