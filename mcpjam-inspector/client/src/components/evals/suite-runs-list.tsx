import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { HostChip } from "@/components/hosts/host-chip";
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
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "./eval-surface-chrome";
import { CrossHostDashboard } from "./cross-host/cross-host-dashboard";

/** Shared column template: run label flexes; Acc/Dur fixed; Time + chevron share the tail. */
const RUNS_LIST_ROW_GRID =
  "grid w-full grid-cols-[minmax(0,1fr)_3rem_3.5rem_minmax(9.5rem,1.15fr)_0.875rem] items-center gap-x-3";

const RUNS_LIST_METRIC_HEADER_CLASS =
  "text-right text-[11px] font-medium uppercase tracking-[0.06em] tabular-nums";

const RUNS_LIST_METRIC_CELL_CLASS =
  "text-right text-xs font-mono tabular-nums text-muted-foreground";

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
  /**
   * When provided, expanding a multi-host run group renders the cross-host
   * comparison matrix for that group's runs. Click a case row to drill in.
   */
  suite?: EvalSuite;
  cases?: EvalCase[];
  onTestCaseClick?: (testCaseId: string) => void;
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
  suite,
  cases,
  onTestCaseClick,
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
        <div className={RUNS_LIST_METRIC_HEADER_CLASS}>{accuracyLabel}</div>
        <div className={RUNS_LIST_METRIC_HEADER_CLASS}>Dur</div>
        <div className={cn(RUNS_LIST_METRIC_HEADER_CLASS, "truncate")}>
          Time
        </div>
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
                suite={suite}
                cases={cases}
                allIterations={allIterations}
                onTestCaseClick={onTestCaseClick}
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
  nested?: boolean;
}

function StandaloneRunRow({
  run,
  runIterations,
  hostNamesById,
  userMap,
  onRunClick,
  nested = false,
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

  const runResult = computeEffectiveRunResult(run, passRate);
  const badge = runResultBadge(runResult);

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
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            nested && "border-l border-border/50 pl-3",
          )}
        >
          <span className="truncate text-xs font-medium">
            Run {formatRunId(run._id)}
          </span>
          {badge ? (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                badge.className,
              )}
            >
              {badge.label}
            </span>
          ) : null}
          {run.source === "schedule" ? (
            <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Scheduled
            </span>
          ) : null}
          {run.namedHostId ? (
            <HostChip
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
        <div className={RUNS_LIST_METRIC_CELL_CLASS}>
          {passRate !== null ? `${passRate}%` : "—"}
        </div>
        <div className={RUNS_LIST_METRIC_CELL_CLASS}>{duration}</div>
        <div
          className={cn(RUNS_LIST_METRIC_CELL_CLASS, "truncate")}
          title={formatTime(timestamp)}
        >
          {timestampLabel}
        </div>
        <ChevronRight
          className="size-3.5 shrink-0 justify-self-end text-muted-foreground"
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
  /** Enables the inline cross-host matrix on expand when present. */
  suite?: EvalSuite;
  cases?: EvalCase[];
  allIterations: EvalIteration[];
  onTestCaseClick?: (testCaseId: string) => void;
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

// Effective result for a run: prefer the explicit `result` set by the recorder
// when present, otherwise derive from live pass rate against passCriteria.
// The recorder finalizes runs with `status: "completed"` + `summary` but does
// not always populate `result`, so a parent that only checks `result === "failed"`
// would render a green border over a child whose passRate is below criteria.
export function computeEffectiveRunResult(
  run: EvalSuiteRun,
  passRate: number | null,
):
  | "passed"
  | "failed"
  | "running"
  | "cancelled"
  | "timed_out"
  | "pending" {
  if (run.result) return run.result;
  if (run.status === "completed" && passRate !== null) {
    return passRate >= (run.passCriteria?.minimumPassRate ?? 100)
      ? "passed"
      : "failed";
  }
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "timed_out") return "timed_out";
  if (run.status === "running") return "running";
  if (run.status === "failed") return "failed";
  return "pending";
}

function runResultBadge(result: ReturnType<typeof computeEffectiveRunResult>) {
  switch (result) {
    case "passed":
      return { label: "Passed", className: "bg-success/50 text-foreground" };
    case "failed":
      return { label: "Failed", className: "bg-destructive/50 text-foreground" };
    case "cancelled":
      return { label: "Cancelled", className: "bg-muted text-muted-foreground" };
    case "timed_out":
      return { label: "Timed out", className: "bg-warning/50 text-foreground" };
    case "running":
      return { label: "Running", className: "bg-warning/50 text-foreground" };
    default:
      return null;
  }
}

function GroupRunRows({
  group,
  iterationsByRun,
  hostNamesById,
  userMap,
  onRunClick,
  isExpanded,
  onToggle,
  suite,
  cases,
  allIterations,
  onTestCaseClick,
}: GroupRunRowsProps) {
  const canRenderMatrix =
    !!suite && !!cases && !!onTestCaseClick && group.runs.length >= 2;
  const shouldRenderMatrix = isExpanded && canRenderMatrix;
  const groupRunIds = useMemo(
    () => new Set(group.runs.map((r) => r._id)),
    [group.runs],
  );
  const groupIterations = useMemo(
    () =>
      shouldRenderMatrix
        ? allIterations.filter(
            (it) => it.suiteRunId && groupRunIds.has(it.suiteRunId),
          )
        : [],
    [shouldRenderMatrix, allIterations, groupRunIds],
  );
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

  // Parent status: pick the "worst" effective status across children so the
  // left border matches what each child row shows. Derive from the same
  // helper the standalone rows use — checking only `run.result`/`run.status`
  // here misses children that the recorder finalized as `status: completed`
  // without setting `result: failed`, even though their passRate is below
  // criteria. Order: running > failed/timed out > cancelled > pending > passed.
  const effectiveResults = childStats.map((c) =>
    computeEffectiveRunResult(c.run, c.stats.passRate),
  );
  const anyRunning = effectiveResults.some((r) => r === "running");
  const anyFailed = effectiveResults.some(
    (r) => r === "failed" || r === "timed_out",
  );
  const anyCancelled = effectiveResults.some((r) => r === "cancelled");
  const anyPending = effectiveResults.some((r) => r === "pending");
  const groupResult:
    | "running"
    | "failed"
    | "cancelled"
    | "passed"
    | "pending"
    | "timed_out" =
    anyRunning
      ? "running"
      : anyFailed
        ? "failed"
        : anyCancelled
          ? "cancelled"
          : anyPending
            ? "pending"
            : "passed";

  const timestampLabel = formatTime(group.latestTimestamp);
  const shortGroupId = group.runGroupId.slice(0, 8);
  const groupBadge = runResultBadge(groupResult);

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
          {groupBadge ? (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                groupBadge.className,
              )}
            >
              {groupBadge.label}
            </span>
          ) : null}
          <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {group.runs.length} hosts
          </span>
        </div>
        <div className={RUNS_LIST_METRIC_CELL_CLASS}>
          {meanPassRate !== null ? `${meanPassRate}%` : "—"}
        </div>
        <div className={RUNS_LIST_METRIC_CELL_CLASS}>
          {maxDuration !== null ? formatDuration(maxDuration) : "—"}
        </div>
        <div
          className={cn(RUNS_LIST_METRIC_CELL_CLASS, "truncate")}
          title={timestampLabel}
        >
          {timestampLabel}
        </div>
        <span aria-hidden className="size-3.5 shrink-0 justify-self-end" />
      </button>

      {isExpanded ? (
        <div className="border-t bg-muted/10" data-testid="run-group-children">
          {childStats.map(({ run, iterations }) => (
            <StandaloneRunRow
              key={run._id}
              run={run}
              runIterations={iterations}
              hostNamesById={hostNamesById}
              userMap={userMap}
              onRunClick={onRunClick}
              nested
            />
          ))}
          {shouldRenderMatrix ? (
            <div className="border-t border-border/40">
              <CrossHostDashboard
                suite={suite!}
                cases={cases!}
                runs={group.runs}
                allIterations={groupIterations}
                expanded
                onTestCaseClick={onTestCaseClick}
                onCellOpen={(cell) => {
                  const runId = cell.iterations[0]?.suiteRunId;
                  if (runId) onRunClick(runId);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
