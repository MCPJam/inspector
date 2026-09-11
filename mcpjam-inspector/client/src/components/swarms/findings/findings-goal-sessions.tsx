/**
 * Clickable sessions for one expanded findings goal — the same list
 * interaction as Insights' GoalOutcomeDrilldown, scoped to that goal.
 *
 * Renders the list only (no card). The parent mounts this under
 * "What happened" so the sessions sit with the evidence they explain.
 *
 * Remount on the goal id (parent keys this) so paging state never leaks
 * across goals.
 */

import { useEffect, useMemo, useState } from "react";
import {
  stageChipValue,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";
import { useGoalOutcomeDrilldown } from "@/hooks/useUsageInsights";

const PAGE_SIZE = 25;

/**
 * How a surface pages one goal's sessions.
 *
 * The two surfaces key a goal differently: a swarm goal IS a run, so it pages
 * by `journeyRunIds`; a User Testing goal is a goal-axis cluster, so it pages
 * by `clusterId`. User Testing also has to carry its hide-synthetic policy
 * here, or this list quietly disagrees with the count that opened it.
 */
export type FindingsSessionScope =
  | { kind: "swarm"; projectId: string }
  | { kind: "scenario"; scenarioId: string; filters?: UsageFilterState };

/**
 * Narrowing the list to the sessions ONE stage is about.
 *
 * `state` follows what the stage's row actually says: a failing stage is about
 * its failures, a passing one about its passes. A stage with no verdict has
 * nothing to narrow to and passes `null`, which leaves the goal's whole list
 * in place rather than showing an empty one.
 */
export type FindingsStageNarrowing = {
  /** The CHAIN's stage id (`userValue`), not the panel's (`value`). */
  chainStage: string;
  state: "passed" | "failed";
};

export function FindingsGoalSessions({
  scope,
  goalId,
  expectedCount: _expectedCount,
  stage,
  onOpenSession,
}: {
  scope: FindingsSessionScope;
  /** The swarm's run id, or the scenario's goal cluster id. */
  goalId: string;
  expectedCount: number;
  /**
   * Narrow to one stage's sessions. Scenario scope only — a swarm goal pages
   * by run id and its backend reader takes no chips.
   */
  stage?: FindingsStageNarrowing | null;
  onOpenSession: (sessionId: string) => void;
}) {
  // The stage chip rides ON TOP of the scope's own filters rather than
  // replacing them: the hide-synthetic policy and the persona's sentiment are
  // what make this list agree with the count that opened it, and dropping
  // either to add a stage would trade one disagreement for another.
  const stageFilters = useMemo(() => {
    const base = scope.kind === "scenario" ? scope.filters : undefined;
    if (!stage) return base;
    const chip: UsageFilterChip = {
      kind: "dimension",
      key: "stage",
      value: stageChipValue(stage.chainStage, stage.state),
    };
    return base
      ? { ...base, chips: [...base.chips, chip] }
      : { preset: "all" as const, chips: [chip] };
  }, [scope, stage]);

  const [before, setBefore] = useState<number | undefined>(undefined);
  const [rows, setRows] = useState<
    Array<{
      _id: string;
      firstMessagePreview?: string;
      lastActivityAt: number;
    }>
  >([]);

  const { drilldown, isLoading } = useGoalOutcomeDrilldown(
    scope.kind === "swarm"
      ? {
          scope: {
            kind: "swarm",
            projectId: scope.projectId,
            journeyRunIds: [goalId],
          },
          clusterId: null,
          outcome: undefined,
          limit: PAGE_SIZE,
          before,
          enabled: true,
        }
      : {
          scope: { kind: "scenario", scenarioId: scope.scenarioId },
          clusterId: goalId,
          outcome: undefined,
          filters: stageFilters,
          limit: PAGE_SIZE,
          before,
          enabled: true,
        },
  );

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
