import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ClientChip } from "@/components/clients/client-chip";
import { cn, getInitials } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  evalStatusLeftBorderClasses,
  formatDuration,
  formatRunId,
  formatTime,
} from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "./types";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "./eval-surface-chrome";

/** Shared column template: run label flexes; Acc/Dur/Time share equal width. */
const RUNS_LIST_ROW_GRID =
  "grid w-full grid-cols-[minmax(0,1.25fr)_repeat(3,minmax(4.5rem,1fr))_1rem] items-center gap-x-4";

/**
 * Per-row effective pass-rate stats. Prefers the live iteration set when
 * any iteration has terminated; falls back to `run.summary` only when no
 * iterations are observable yet. Exported as a tiny pure helper so the
 * parent group row and the child rows compute aggregates from the same
 * source — otherwise parent vs. children diverge during live updates.
 */
export function computeRunEffectiveStats(
  run: EvalSuiteRun,
  runIterations: EvalIteration[],
): {
  effectivePassed: number;
  effectiveTotal: number;
  passRate: number | null;
} {
  const iterationResults = runIterations.map((i) => computeIterationResult(i));
  const passed = iterationResults.filter((r) => r === "passed").length;
  const failed = iterationResults.filter((r) => r === "failed").length;
  const completedTotal = passed + failed;
  const summaryPassed = run.summary?.passed ?? 0;
  const summaryTotal = run.summary?.total ?? 0;

  const effectivePassed = completedTotal > 0 ? passed : summaryPassed;
  const effectiveTotal = completedTotal > 0 ? completedTotal : summaryTotal;
  const passRate =
    effectiveTotal > 0
      ? Math.round((effectivePassed / effectiveTotal) * 100)
      : null;
  return { effectivePassed, effectiveTotal, passRate };
}

export interface SuiteRunsListProps {
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  suiteSource?: "ui" | "sdk";
  onRunClick: (runId: string) => void;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  /** Optional cap; when set, list shows at most N rows with a footer count. */
  maxVisibleRuns?: number;
  runsLoading?: boolean;
  /**
   * Resolves `namedHostId` → display name for runs that were triggered
   * against a specific attached host. When omitted, host badges show
   * truncated IDs instead. Pass the suite's `hostAttachments` to feed it.
   */
  hostNamesById?: Map<string, string | null>;
  className?: string;
}

type RunGroupNode = {
  kind: "group";
  /** Stable key shared by all child runs (the runGroupId itself). */
  key: string;
  runGroupId: string;
  runs: EvalSuiteRun[];
  /** Latest timestamp across children (completedAt ?? createdAt). */
  latestTimestamp: number;
};

type RunStandaloneNode = {
  kind: "standalone";
  /** The run id, used as a stable key. */
  key: string;
  run: EvalSuiteRun;
  latestTimestamp: number;
};

type RunListNode = RunGroupNode | RunStandaloneNode;

function getRunTimestamp(run: EvalSuiteRun): number {
  return run.completedAt ?? run.createdAt ?? 0;
}

/**
 * Compact read-only runs list rendered inside the suite dashboard. Sits next to
 * the test cases panel as one of two balanced columns — no toolbar, no
 * selection, no batch delete. Use {@link RunOverview} when the full runs table
 * with admin affordances is needed.
 */
export function SuiteRunsList({
  runs,
  allIterations,
  suiteSource,
  onRunClick,
  userMap,
  maxVisibleRuns,
  runsLoading = false,
  hostNamesById,
  className,
}: SuiteRunsListProps) {
  const isSdk = suiteSource === "sdk";
  const accuracyLabel = isSdk ? "Pass" : "Acc";

  const iterationsByRun = useMemo(() => {
    const map = new Map<string, EvalIteration[]>();
    for (const iteration of allIterations) {
      if (!iteration.suiteRunId) continue;
      const list = map.get(iteration.suiteRunId) ?? [];
      list.push(iteration);
      map.set(iteration.suiteRunId, list);
    }
    return map;
  }, [allIterations]);

  // Build the list of nodes — one entry per group, one per standalone
  // run — sorted newest-first by the latest child timestamp in each
  // group. Runs without `runGroupId` render exactly as before (no
  // chevron, no aggregate), preserving the legacy layout.
  const nodes = useMemo<RunListNode[]>(() => {
    const groups = new Map<string, EvalSuiteRun[]>();
    const standalones: EvalSuiteRun[] = [];
    for (const run of runs) {
      if (run.runGroupId) {
        const existing = groups.get(run.runGroupId);
        if (existing) existing.push(run);
        else groups.set(run.runGroupId, [run]);
      } else {
        standalones.push(run);
      }
    }

    const groupNodes: RunListNode[] = [];
    for (const [groupId, groupRuns] of groups.entries()) {
      // Single-member groups can happen if a multi-host POST settles with
      // only one row visible (slow Convex sync). Render them as standalones
      // so the user never sees an empty-looking parent during the gap.
      if (groupRuns.length < 2) {
        for (const run of groupRuns) {
          standalones.push(run);
        }
        continue;
      }
      const sortedChildren = [...groupRuns].sort(
        (a, b) => getRunTimestamp(b) - getRunTimestamp(a),
      );
      const latestTimestamp = sortedChildren.reduce(
        (max, r) => Math.max(max, getRunTimestamp(r)),
        0,
      );
      groupNodes.push({
        kind: "group",
        key: groupId,
        runGroupId: groupId,
        runs: sortedChildren,
        latestTimestamp,
      });
    }

    const standaloneNodes: RunListNode[] = standalones.map((run) => ({
      kind: "standalone",
      key: run._id,
      run,
      latestTimestamp: getRunTimestamp(run),
    }));

    return [...groupNodes, ...standaloneNodes].sort(
      (a, b) => b.latestTimestamp - a.latestTimestamp,
    );
  }, [runs]);

  // Cap by *groups* (nodes), not raw rows, so a group is never split
  // mid-expansion. Footer count is in node terms too.
  const visibleNodes = useMemo(() => {
    if (typeof maxVisibleRuns === "number" && maxVisibleRuns > 0) {
      return nodes.slice(0, maxVisibleRuns);
    }
    return nodes;
  }, [nodes, maxVisibleRuns]);

  const hiddenNodeCount = nodes.length - visibleNodes.length;

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleGroup = (groupId: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  return (
    <div
      className={cn("flex min-h-0 flex-col", evalSurfaceCardClass, className)}
    >
      <div
        className={cn(
          RUNS_LIST_ROW_GRID,
          evalSurfaceHeaderClass,
          "shrink-0 rounded-t-2xl px-4 py-2 text-xs font-medium text-muted-foreground",
        )}
      >
        <div className="min-w-0 truncate">Run</div>
        <div className="text-right">{accuracyLabel}</div>
        <div className="text-right">Dur</div>
        <div className="truncate text-right">Time</div>
        <span aria-hidden />
      </div>

      <div className="max-h-[520px] divide-y overflow-y-auto">
        {runsLoading && nodes.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            Loading runs…
          </div>
        ) : nodes.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No runs yet. Run this suite to see results here.
          </div>
        ) : (
          visibleNodes.map((node) => {
            if (node.kind === "standalone") {
              return (
                <StandaloneRunRow
                  key={node.key}
                  run={node.run}
                  runIterations={iterationsByRun.get(node.run._id) ?? []}
                  hostNamesById={hostNamesById}
                  userMap={userMap}
                  onRunClick={onRunClick}
                />
              );
            }
            const isExpanded = expandedGroups.has(node.runGroupId);
            return (
              <GroupRunRows
                key={node.key}
                group={node}
                iterationsByRun={iterationsByRun}
                hostNamesById={hostNamesById}
                userMap={userMap}
                onRunClick={onRunClick}
                isExpanded={isExpanded}
                onToggle={() => toggleGroup(node.runGroupId)}
              />
            );
          })
        )}
      </div>

      {hiddenNodeCount > 0 ? (
        <div className="shrink-0 border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
          Showing {visibleNodes.length} of {nodes.length} runs
        </div>
      ) : null}
    </div>
  );
}

interface StandaloneRunRowProps {
  run: EvalSuiteRun;
  runIterations: EvalIteration[];
  hostNamesById?: Map<string, string | null>;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  onRunClick: (runId: string) => void;
}

function StandaloneRunRow({
  run,
  runIterations,
  hostNamesById,
  userMap,
  onRunClick,
}: StandaloneRunRowProps) {
  const { passRate } = computeRunEffectiveStats(run, runIterations);

  const duration =
    run.completedAt && run.createdAt
      ? formatDuration(run.completedAt - run.createdAt)
      : run.createdAt && run.status === "running"
        ? formatDuration(Date.now() - run.createdAt)
        : "—";

  const timestamp = run.completedAt ?? run.createdAt;
  const timestampLabel = formatTime(timestamp);

  const runResult =
    run.result ||
    (run.status === "completed" && passRate !== null
      ? passRate >= (run.passCriteria?.minimumPassRate ?? 100)
        ? "passed"
        : "failed"
      : run.status === "cancelled"
        ? "cancelled"
        : run.status === "running"
          ? "running"
          : "pending");

  const creator = run.createdBy ? userMap?.get(run.createdBy) : undefined;

  return (
    <div
      className={cn(
        "relative border-l-2",
        evalStatusLeftBorderClasses(runResult),
      )}
    >
      <button
        type="button"
        onClick={() => onRunClick(run._id)}
        className={cn(
          RUNS_LIST_ROW_GRID,
          "px-4 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          evalSurfaceRowHoverClass,
        )}
        aria-label={`Open run ${formatRunId(run._id)}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">
            Run {formatRunId(run._id)}
          </span>
          {run.namedHostId ? (
            <ClientChip
              name={
                hostNamesById?.get(run.namedHostId) ??
                formatRunId(run.namedHostId)
              }
              hostId={run.namedHostId}
              className="shrink-0 max-w-[140px] gap-1 border-primary/35 bg-primary/10 px-2 py-0.5 text-[10px] text-primary shadow-none"
            />
          ) : null}
          {creator ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Avatar className="size-5 shrink-0">
                  <AvatarImage src={creator.imageUrl} alt={creator.name} />
                  <AvatarFallback className="text-[9px]">
                    {getInitials(creator.name)}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">{creator.name}</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="text-right text-xs font-mono tabular-nums text-muted-foreground">
          {passRate !== null ? `${passRate}%` : "—"}
        </div>
        <div className="text-right text-xs font-mono tabular-nums text-muted-foreground">
          {duration}
        </div>
        <div
          className="truncate text-right text-xs tabular-nums text-muted-foreground"
          title={formatTime(timestamp)}
        >
          {timestampLabel}
        </div>
        <ChevronRight
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-hidden
        />
      </button>
    </div>
  );
}

interface GroupRunRowsProps {
  group: RunGroupNode;
  iterationsByRun: Map<string, EvalIteration[]>;
  hostNamesById?: Map<string, string | null>;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  onRunClick: (runId: string) => void;
  isExpanded: boolean;
  onToggle: () => void;
}

function computeChildDuration(run: EvalSuiteRun): number | null {
  if (run.completedAt && run.createdAt) {
    return Math.max(run.completedAt - run.createdAt, 0);
  }
  if (run.createdAt && run.status === "running") {
    return Math.max(Date.now() - run.createdAt, 0);
  }
  return null;
}

function GroupRunRows({
  group,
  iterationsByRun,
  hostNamesById,
  userMap,
  onRunClick,
  isExpanded,
  onToggle,
}: GroupRunRowsProps) {
  // Per-child effective stats — same source the standalone rows use.
  const childStats = group.runs.map((run) => ({
    run,
    iterations: iterationsByRun.get(run._id) ?? [],
    stats: computeRunEffectiveStats(
      run,
      iterationsByRun.get(run._id) ?? [],
    ),
  }));

  // Mean across children's effective pass rates. Children with a null
  // passRate (no iterations yet AND no summary) are excluded from the
  // mean — counting them as 0 would dilute the live aggregate.
  const childRates = childStats
    .map((c) => c.stats.passRate)
    .filter((p): p is number => p !== null);
  const meanPassRate =
    childRates.length > 0
      ? Math.round(
          childRates.reduce((sum, p) => sum + p, 0) / childRates.length,
        )
      : null;

  const childDurations = childStats
    .map((c) => computeChildDuration(c.run))
    .filter((d): d is number => d !== null);
  const maxDuration =
    childDurations.length > 0 ? Math.max(...childDurations) : null;

  // Parent status: pick the "worst" status across children so the left
  // border accurately reflects partial failure / running state.
  const anyRunning = group.runs.some((r) => r.status === "running");
  const anyFailed = group.runs.some(
    (r) => r.result === "failed" || r.status === "failed",
  );
  const anyCancelled = group.runs.some(
    (r) => r.status === "cancelled" || r.result === "cancelled",
  );
  const allCompleted = group.runs.every((r) => r.status === "completed");
  const groupResult: "running" | "failed" | "cancelled" | "passed" | "pending" =
    anyRunning
      ? "running"
      : anyFailed
        ? "failed"
        : anyCancelled
          ? "cancelled"
          : allCompleted
            ? "passed"
            : "pending";

  const timestampLabel = formatTime(group.latestTimestamp);
  const shortGroupId = group.runGroupId.slice(0, 8);

  return (
    <div
      className={cn(
        "relative border-l-2",
        evalStatusLeftBorderClasses(groupResult),
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className={cn(
          RUNS_LIST_ROW_GRID,
          "px-4 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          evalSurfaceRowHoverClass,
        )}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} run group g${shortGroupId}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isExpanded ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="truncate text-xs font-medium">
            Run group g{shortGroupId}
          </span>
          <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {group.runs.length} hosts
          </span>
        </div>
        <div className="text-right text-xs font-mono tabular-nums text-muted-foreground">
          {meanPassRate !== null ? `${meanPassRate}%` : "—"}
        </div>
        <div className="text-right text-xs font-mono tabular-nums text-muted-foreground">
          {maxDuration !== null ? formatDuration(maxDuration) : "—"}
        </div>
        <div
          className="truncate text-right text-xs tabular-nums text-muted-foreground"
          title={timestampLabel}
        >
          {timestampLabel}
        </div>
        <span aria-hidden />
      </button>

      {isExpanded ? (
        <div
          className="border-t bg-muted/10 pl-4"
          data-testid="run-group-children"
        >
          {childStats.map(({ run, iterations }) => (
            <StandaloneRunRow
              key={run._id}
              run={run}
              runIterations={iterations}
              hostNamesById={hostNamesById}
              userMap={userMap}
              onRunClick={onRunClick}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
