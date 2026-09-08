/**
 * Clickable sessions for one expanded findings goal — the same list
 * interaction as Insights' GoalOutcomeDrilldown, scoped to this run.
 *
 * Renders the list only (no card). The parent mounts this under
 * "What happened" so the sessions sit with the evidence they explain.
 *
 * Remount on `runId` (parent keys this) so paging state never leaks across
 * goals.
 */

import { useEffect, useState } from "react";
import { useGoalOutcomeDrilldown } from "@/hooks/useUsageInsights";

const PAGE_SIZE = 25;

export function FindingsGoalSessions({
  projectId,
  runId,
  expectedCount: _expectedCount,
  onOpenSession,
}: {
  projectId: string;
  runId: string;
  expectedCount: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const [before, setBefore] = useState<number | undefined>(undefined);
  const [rows, setRows] = useState<
    Array<{
      _id: string;
      firstMessagePreview?: string;
      lastActivityAt: number;
    }>
  >([]);

  const { drilldown, isLoading } = useGoalOutcomeDrilldown({
    scope: { kind: "swarm", projectId, journeyRunIds: [runId] },
    clusterId: null,
    outcome: undefined,
    limit: PAGE_SIZE,
    before,
    enabled: true,
  });

  useEffect(() => {
    if (!drilldown) return;
    setRows((prev) => {
      const seen = new Set(prev.map((row) => row._id));
      const fresh = drilldown.sessions.filter((row) => !seen.has(row._id));
      return fresh.length === 0 ? prev : [...prev, ...fresh];
    });
  }, [drilldown]);

  const nextBefore = drilldown?.nextBefore ?? null;

  return (
    <div
      className="mt-2 border-t border-white/10 pt-1"
      data-testid="findings-goal-sessions"
      aria-label="Sessions for this goal"
    >
      {isLoading && rows.length === 0 ? (
        <p className="py-2 text-xs text-zinc-400">Loading sessions…</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-xs text-zinc-400">No sessions to open yet.</p>
      ) : (
        <ul className="divide-y divide-white/10">
          {rows.map((session, index) => {
            const preview = session.firstMessagePreview?.trim();
            return (
              <li key={session._id}>
                <button
                  type="button"
                  className="flex min-h-10 w-full items-center gap-4 rounded-sm px-1.5 text-left hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                  onClick={() => onOpenSession(session._id)}
                  data-testid="findings-goal-session"
                >
                  <span className="shrink-0 text-xs font-medium text-orange-300">
                    Session {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-50">
                    {preview ? `"${preview}"` : "(no preview)"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {nextBefore != null ? (
        <button
          type="button"
          className="mt-2 text-[11px] font-medium text-orange-300 underline-offset-4 hover:text-orange-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
          onClick={() => setBefore(nextBefore)}
        >
          Load {PAGE_SIZE} more
        </button>
      ) : null}
    </div>
  );
}
