/**
 * The sessions ONE piece of stage evidence implicates.
 *
 * Scoped by `EvidenceSessions`, never by the goal: a run-scoped list renders
 * identical rows under all six stages of the chain and contradicts the
 * denominator printed beside it.
 *
 * The run is paginated to EXHAUSTION before the list is presented, for the
 * same reason `FindingSessions` does it in `swarm-overview-panel`: the
 * evidence's count is over every session in the run, so a filtered first page
 * would quietly show two rows under a claim of four with nothing on screen
 * admitting the list was partial. A run is bounded at hosts ×
 * sessionsPerTarget, so that costs a page or two.
 *
 * Remount on `runId` (parent keys this) so paging never leaks across goals.
 */

import { useEffect, useMemo } from "react";
import { usePaginatedQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  type JourneySessionRow,
} from "@/lib/swarm-api";
import type { EvidenceSessions } from "./findings-derivation";

/** Copy for a scope that matched nothing. Never "no sessions" flat — which
 *  scope came up empty is the whole information. */
const EMPTY_COPY: Record<Exclude<EvidenceSessions["kind"], "none">, string> = {
  criterion: "No session in this run carries a failing verdict for this check.",
  goalScoreFail: "No session in this run carries a failed completion grade.",
  ids: "The detector named no session for this run.",
};

function matchesEvidence(
  row: JourneySessionRow,
  sessions: Exclude<EvidenceSessions, { kind: "none" } | { kind: "ids" }>
): boolean {
  if (sessions.kind === "criterion") {
    // `results` exists only on a COMPLETED grade, which is exactly the set
    // we want — a pending or broken grade asserts nothing about this check.
    return (row.criteria?.results ?? []).some(
      (result) =>
        result.criterionId === sessions.criterionId && result.passed === false
    );
  }
  return (
    row.goalScore?.status === "completed" && row.goalScore.passed === false
  );
}

export function FindingsEvidenceSessions({
  runId,
  sessions,
  onOpenSession,
}: {
  runId: string;
  /** `none` is filtered out by the caller — this component always has rows to seek. */
  sessions: Exclude<EvidenceSessions, { kind: "none" }>;
  onOpenSession: (sessionId: string) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { journeyRunId: runId } as any,
    { initialNumItems: Math.max(DEFAULT_PAGE_SIZE, 25) }
  );

  // Walk to the end of the run. Bounded by the run's own size, and each call
  // moves status to `LoadingMore`, so this advances once per landed page
  // rather than spinning.
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(DEFAULT_PAGE_SIZE);
  }, [status, loadMore]);

  const rows = (results ?? []) as JourneySessionRow[];

  const matched = useMemo<Array<{ id: string; preview?: string }>>(() => {
    if (sessions.kind === "ids") {
      // Ordered by the miner's worst-first list, NOT by the run's paging.
      // A persona-scoped candidate can name a session from a sibling run, so
      // an id with no row here still gets an openable row without a preview
      // rather than being silently dropped from a count we printed.
      const byId = new Map(rows.map((row) => [row.id, row]));
      return sessions.ids.map((id) => {
        const preview = byId.get(id)?.firstMessagePreview?.trim();
        return preview ? { id, preview } : { id };
      });
    }
    return rows.filter((row) => matchesEvidence(row, sessions)).map((row) => {
      const preview = row.firstMessagePreview?.trim();
      return preview ? { id: row.id, preview } : { id: row.id };
    });
  }, [rows, sessions]);

  // Hold the spinner until the run is fully loaded. Rendering mid-walk would
  // flash a shorter list than the evidence's own count claims — the exact
  // discrepancy the walk exists to avoid.
  if (status !== "Exhausted") {
    return (
      <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2 text-xs text-zinc-400">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Loading sessions…
      </div>
    );
  }

  return (
    <div
      className="mt-2 border-t border-white/10 pt-1"
      data-testid="findings-evidence-sessions"
      data-scope={sessions.kind}
      aria-label="Sessions for this finding"
    >
      {matched.length === 0 ? (
        <p className="py-2 text-xs text-zinc-400">{EMPTY_COPY[sessions.kind]}</p>
      ) : (
        <ul className="divide-y divide-white/10">
          {matched.map((session, index) => (
            <li key={session.id}>
              <button
                type="button"
                className="flex min-h-10 w-full items-center gap-4 rounded-sm px-1.5 text-left hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                onClick={() => onOpenSession(session.id)}
                data-testid="findings-evidence-session"
                data-session-id={session.id}
              >
                <span className="shrink-0 text-xs font-medium text-orange-300">
                  Session {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-50">
                  {session.preview ? `"${session.preview}"` : "(no preview)"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
