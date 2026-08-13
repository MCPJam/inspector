import { formatScore } from "@/components/shared/session-quality/judge-presentation";
import type { GoalScoreRollup, JourneyRun } from "@/lib/swarm-api";

// ── run status treatment ─────────────────────────────────────────────────────

/**
 * The status to SHOW for a run.
 *
 * The backend records two special endings as a marker on `error` rather than
 * as a status, so both arrive as `status: "failed"`:
 *
 *   canceled      — somebody stopped this run on purpose
 *   stale_runner  — the runner went silent; the watchdog settled it
 *
 * Neither is a failure of the thing being tested, and painting them red says
 * something untrue. Reading `status` alone did exactly that; `stale` was even
 * in the status union already, and nothing ever produced it, so the chip's
 * `case "stale"` was dead code standing in for a state it never received.
 */
export function journeyRunDisplayStatus(run: {
  status: string;
  error?: string;
}): string {
  if (run.error === "canceled") return "canceled";
  if (run.error === "stale_runner") return "stale";
  return run.status;
}

export function runStatusChipClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "partial":
    case "rate_limited":
      return "bg-muted text-muted-foreground";
    case "failed":
      return "bg-red-500/10 text-red-700 dark:text-red-400";
    // Deliberately NOT the failure treatment. A stopped run and an abandoned
    // one are outcomes, not verdicts — the same neutral chip `partial` gets.
    case "canceled":
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

/** Absolute stamp for Swarm Run detail headers — `AUG 3, 2026 · 2:14 PM`. */
export function formatSwarmAbsoluteTime(timestamp: number): string {
  const d = new Date(timestamp);
  const date = d
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

/** `· goal 78% avg (4 judged)` — used on journey run rows. */
export function goalScoreAvgLabel(
  rollup: GoalScoreRollup | undefined
): string | null {
  if (!rollup || rollup.gradedCount === 0 || rollup.avgScore === null) {
    return null;
  }
  return `goal ${formatScore(rollup.avgScore)} avg (${
    rollup.gradedCount
  } judged)`;
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
