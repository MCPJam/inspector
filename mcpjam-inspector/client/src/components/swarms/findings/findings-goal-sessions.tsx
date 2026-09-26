/**
 * Clickable sessions for one expanded findings goal — the same list
 * interaction as Insights' GoalOutcomeDrilldown, scoped to that goal.
 *
 * Renders the list only (no card). The parent mounts this under the
 * open stage so the sessions sit with the evidence they explain.
 *
 * The parent keys this on the goal, the narrowing and the scope, so the
 * CURSOR and the pages already fetched cannot outlive the selection that
 * fetched them. The page in view reconciles itself; `before` does not.
 */

import type { UserValueStage } from "@mcpjam/sdk/contract";
import { useEffect, useMemo, useState } from "react";
import {
  stageChipValue,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";
import { useGoalOutcomeDrilldown } from "@/hooks/useUsageInsights";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import { threadNeverRan } from "@/components/swarms/swarm-session-not-run";

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
  /**
   * The CHAIN's stage id, typed so it cannot be the panel's.
   *
   * These two vocabularies differ in exactly one member — the chain says
   * `userValue` where the panel says `value` — and a caller handing over
   * `selectedStage` instead of `CHAIN_STAGE_BY_JOURNEY[selectedStage]` used to
   * compile clean and build `"value:failed"`, which matches no row on the
   * server: an empty list under a header reading "Failed".
   */
  chainStage: UserValueStage;
  state: "passed" | "failed";
};

/**
 * Is this the same page, by everything the list renders?
 *
 * Compares the fields shown rather than object identity: the query hands back
 * a stable reference for unchanged data, but nothing in the type says so, and
 * a caller that re-allocates must not be able to spin the effect below.
 */
function samePage(
  a: ReadonlyArray<SessionRow> | undefined,
  b: ReadonlyArray<SessionRow>,
): boolean {
  if (a === b) return true;
  if (!a || a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      row._id === b[i]!._id &&
      row.firstMessagePreview === b[i]!.firstMessagePreview &&
      // Every field `threadNeverRan` reads decides whether the row reads
      // "Didn't run", and an attempt that settles while the goal is open must
      // be allowed to change it.
      row.sourceType === b[i]!.sourceType &&
      row.neverRan === b[i]!.neverRan &&
      row.runAttemptStatus === b[i]!.runAttemptStatus &&
      row.runAttemptErrorCode === b[i]!.runAttemptErrorCode &&
      row.messageCount === b[i]!.messageCount,
  );
}

/** What one row renders, and what `threadNeverRan` reads. */
type SessionRow = Pick<
  SharedChatThread,
  | "_id"
  | "firstMessagePreview"
  | "lastActivityAt"
  | "sourceType"
  | "messageCount"
  | "neverRan"
  | "runAttemptStatus"
  | "runAttemptErrorCode"
>;

/** `undefined` (the first page) and a real cursor must not collide. */
function cursorKey(cursor: number | null | undefined): string {
  return cursor == null ? "first" : String(cursor);
}

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
  /**
   * Pages, kept BY THE CURSOR that produced them rather than concatenated.
   *
   * The drilldown is a live query, so its answer for the page in view changes
   * under us — a session regraded while the goal is open stops matching the
   * stage that opened it. Appending only rows we had not seen could never
   * express that: the row stayed until the whole list remounted, and clicking
   * it landed on a transcript that no longer failed where the header said.
   *
   * Only the page named by `before` is subscribed, so earlier pages stay as
   * the snapshots they were. That is the honest limit of one subscription, and
   * it still fixes the case that actually happens: nobody has clicked "load
   * more", there is one page, and it is live.
   */
  const [pageCursors, setPageCursors] = useState<Array<number | null>>([null]);
  const [pagesByCursor, setPagesByCursor] = useState<
    Record<string, SessionRow[]>
  >({});

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
    setPagesByCursor((prev) => {
      const key = cursorKey(before);
      // BAILS OUT when the page is unchanged, and that is load-bearing rather
      // than an optimisation. This effect keys on the query result, and a
      // result that is equal but freshly allocated on every render — which is
      // what a `mockImplementation` test double does — would otherwise go
      // set state → render → new object → set state forever. The append-only
      // version had this property by accident, because it returned `prev`
      // whenever it found no unseen ids.
      if (samePage(prev[key], drilldown.sessions)) return prev;
      // Otherwise REPLACE. The previous answer for this cursor is gone, which
      // is the whole point.
      return { ...prev, [key]: drilldown.sessions };
    });
  }, [drilldown, before]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionRow[] = [];
    for (const cursor of pageCursors) {
      for (const session of pagesByCursor[cursorKey(cursor)] ?? []) {
        // Pages are cursor-bounded and do not normally overlap, but a page
        // that shrank can let the next one slide back over it. Rendering a
        // session twice would double a count the reader is checking.
        if (seen.has(session._id)) continue;
        seen.add(session._id);
        out.push(session);
      }
    }
    return out;
  }, [pageCursors, pagesByCursor]);

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
            // Drilldown rows arrive with no `sourceType`: the backend
            // normalizes `swarm` away on every list row. This list is swarm
            // scoped by construction, so it says so for them.
            const neverRan = threadNeverRan(
              scope.kind === "swarm"
                ? { ...session, sourceType: "swarm" }
                : session,
            );
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
                  {/* A refused session has no preview, and "(no preview)"
                      read as a session that ran and said nothing (#5188). */}
                  {neverRan ? (
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-zinc-400"
                      data-testid="findings-goal-session-never-ran"
                    >
                      Didn't run
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-50">
                      {preview ? `"${preview}"` : "(no preview)"}
                    </span>
                  )}
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
          onClick={() => {
            setBefore(nextBefore);
            setPageCursors((prev) =>
              prev.includes(nextBefore) ? prev : [...prev, nextBefore],
            );
          }}
        >
          Load {PAGE_SIZE} more
        </button>
      ) : null}
    </div>
  );
}
