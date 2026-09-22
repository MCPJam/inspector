/**
 * What the benchmark screen is showing, derived from the server's answer alone.
 *
 * The conformance runner next door executes its suites IN THE BROWSER, which
 * is why it carries a `run-complete` phase: `runAll` schedules React state
 * updates and then resolves, so its continuation can run before the commit and
 * read a pre-run snapshot. None of that applies here. A benchmark runs on the
 * backend, every phase below is a function of one `GET /runs/:runId` response,
 * and the browser holds no state the server does not already have — which is
 * what makes refresh, resume and a second tab all work with no extra
 * machinery. Adding a commit-race phase here would be copying a workaround for
 * a problem this flow does not have.
 *
 * Nothing in this module derives a number, a score, or a verdict. It maps the
 * backend's lifecycle onto the four things the screen can be doing.
 */

import {
  isTerminalBenchRunStatus,
  type BenchRun,
  type BenchRunStatus,
} from "@/lib/apis/bench-api";

/**
 * The screens, in order.
 *
 *   - `select`   — choosing a category and track. No run exists.
 *   - `quote`    — a priced, consentable plan. Still no run.
 *   - `progress` — a run exists and has not settled.
 *   - `report`   — a run has settled, whatever it settled as.
 */
export type BenchPhase = "select" | "quote" | "progress" | "report";

export function benchPhaseForRun(run: BenchRun | null): BenchPhase {
  if (!run) return "select";
  return isTerminalBenchRunStatus(run.status) ? "report" : "progress";
}

/**
 * Whether the poller should ask again.
 *
 * Terminal is terminal: a settled run's row never changes again, so continuing
 * to poll one spends the caller's rate-limit budget on an answer that cannot
 * move.
 */
export function shouldPollBenchRun(run: BenchRun | null): boolean {
  return run !== null && !isTerminalBenchRunStatus(run.status);
}

/**
 * What the visitor is told while a run is in flight.
 *
 * `awaiting_evidence` and `assembling` are separate states in the backend and
 * stay separate here: the first is "children are still reporting", the second
 * is "we are interpreting what they reported", and a visitor watching a
 * 45-minute exam is owed the difference. Collapsing both into "Running" is how
 * a stuck assembly reads as a stuck run.
 */
const IN_FLIGHT_LABELS: Partial<Record<BenchRunStatus, string>> = {
  queued: "Queued",
  running: "Running the exam",
  awaiting_evidence: "Collecting results",
  assembling: "Scoring",
};

export function benchProgressLabel(run: BenchRun): string {
  if (run.cancelRequested && !isTerminalBenchRunStatus(run.status)) {
    return "Cancelling";
  }
  return IN_FLIGHT_LABELS[run.status] ?? "Running the exam";
}

/**
 * How far through the matrix a run is, as a fraction, or `null`.
 *
 * `null` rather than 0 whenever the denominator is missing or zero. A
 * progress bar pinned at the left is a claim that nothing has happened; "we
 * don't know yet" is a different statement, and the caller renders it as one.
 */
export function benchProgressFraction(run: BenchRun): number | null {
  const progress = run.progress;
  if (!progress) return null;
  const pairs: Array<[number | undefined, number | undefined]> = [
    [progress.repetitionsCompleted, progress.repetitionsTotal],
    [progress.cellsCompleted, progress.cellsTotal],
    [progress.casesCompleted, progress.casesTotal],
  ];
  for (const [done, total] of pairs) {
    if (typeof done !== "number" || typeof total !== "number") continue;
    if (total <= 0) continue;
    return Math.max(0, Math.min(1, done / total));
  }
  return null;
}

/**
 * How a settled run reads.
 *
 * `failed` is OURS and `completed` is the target's: a connector that failed
 * every check produces a completed run holding a bad score, and reporting that
 * as a failure of the benchmark would let a real verdict hide behind an
 * apology. `insufficient_evidence` is a third thing again — we ran, and what
 * came back does not support a claim either way.
 */
export type BenchOutcomeTone = "scored" | "partial" | "stopped" | "failed";

export function benchOutcomeTone(status: BenchRunStatus): BenchOutcomeTone {
  switch (status) {
    case "completed":
      return "scored";
    case "provisional":
    case "insufficient_evidence":
      return "partial";
    case "cancelled":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "partial";
  }
}
