/**
 * Master-detail results surface for a multi-host suite. Replaces the
 * Runs ⟷ Cases tab switcher with one screen:
 *   • Left rail  — the run timeline. The unit is a RUN GROUP (one launch across
 *                  N hosts; child runs share `runGroupId`, differ by
 *                  `namedHostId`). Single-host launches render as standalone
 *                  items. A pinned "All runs" item sits on top, and an optional
 *                  "Monitoring" item at the bottom.
 *   • Right pane — scoped to the selection, all sharing one case×host matrix:
 *       · "All runs"  → `CrossHostDashboard` across every run (latest per host
 *                       + historical columns). Falls back to the authoring case
 *                       library (`allRunsPane`) when there's no host-scoped run
 *                       data yet (no attachments / no runs).
 *       · a run group → `CrossHostDashboard` scoped to that one launch.
 *       · a single run → the folded run detail (`runDetailPane`), whose table is
 *                       the same matrix scoped to that run's host.
 *       · "Compare"   → two-group diff. "Monitoring" → the MonitoringTab.
 *
 * This is the default (and only) suite results surface — there is no Runs/Cases
 * tab fallback. The rail collapses to a gutter of run dots when the table needs
 * full width.
 */
import { useEffect, useMemo, useState } from "react";
import {
  GitCompareArrows,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  Layers,
  Activity,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { cn } from "@/lib/utils";
import { HostChip } from "@/components/hosts/host-chip";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";
import { computeRunEffectiveStats } from "./suite-runs-list";
import { formatRelativeTime, formatRunId } from "./helpers";
import { CrossHostDashboard } from "./cross-host/cross-host-dashboard";
import { GroupCrossHostDashboard } from "./group-cross-host-dashboard";
import {
  CASE_ROW_SORT_STORAGE_KEY,
  CaseRowSortControl,
} from "./cross-host/case-row-sort-control";
import type { CaseRowSort } from "./cross-host/case-row-metrics";
import { usePersistedState } from "./use-persisted-state";
import { MonitoringTab } from "./monitoring-tab";
import { SuiteGroupCompare } from "./suite-group-compare";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "./constants";

export interface SuiteResultsSplitProps {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  /** namedHostId → display name, from suite.hostAttachments. */
  hostNamesById: Map<string, string | null>;
  /**
   * The full "All runs" surface (TestCasesOverview), built by the parent so we
   * don't re-thread its ~20 props. Shown when the "All runs" rail item is
   * selected.
   */
  allRunsPane: React.ReactNode;
  onTestCaseClick: (testCaseId: string) => void;
  /**
   * Open a specific case iteration (the case's Runs/replay view focused on that
   * iteration). Wired to matrix cell clicks — a cell IS one (case, host) result.
   */
  onOpenCaseIteration?: (caseId: string, iterationId: string) => void;
  /** Open a single run's detail (parent navigates → updates `selectedRunId`). */
  onRunClick: (runId: string) => void;
  /** Render the Monitoring rail item + pane. */
  showMonitoring?: boolean;
  /**
   * The run currently in the URL. When set, the right pane shows `runDetailPane`
   * and the rail highlights that run (auto-expanding its group). The URL is the
   * source of truth — the split doesn't own run selection.
   */
  selectedRunId?: string | null;
  /** Prebuilt run-detail surface (RunDetailView), shown when a run is selected. */
  runDetailPane?: React.ReactNode;
  /** Leave the run (back to suite overview) — clears the URL run id. */
  onExitRun?: () => void;
  /**
   * Delete a single run. When provided, the rail shows a hover trash on each run
   * (and run group — deleting a group removes all its host runs).
   */
  onDeleteRun?: (runId: string) => Promise<void>;
  /** Delete test cases — renders a trash control on each matrix case row. */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  /**
   * Reports the selected multi-host run group (≥2 runs) so the dashboard's
   * insight banner can show cross-host diagnosis for it. Fires `null` whenever
   * the selection isn't a multi-host group.
   */
  onGroupScopeChange?: (
    scope: { suiteId: string; runGroupId: string; runs: EvalSuiteRun[] } | null,
  ) => void;
}

// ─── Run-group model ─────────────────────────────────────────────────────────

type RailGroup = {
  /** runGroupId for true groups, run._id for standalone runs. */
  key: string;
  /** Short, stable display label. */
  label: string;
  isStandalone: boolean;
  /** Newest-first. */
  runs: EvalSuiteRun[];
  timestamp: number;
  passRate: number | null;
  hostCount: number;
};

const runTimestamp = (r: EvalSuiteRun): number =>
  r.completedAt ?? r.createdAt ?? r._creationTime ?? 0;

function toneFor(value: number): string {
  return value >= 85 ? "bg-success" : value >= 70 ? "bg-amber-500" : "bg-destructive";
}
function textToneFor(value: number): string {
  return value >= 85
    ? "text-success"
    : value >= 70
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
}

function Sparkbar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", toneFor(value))} style={{ width: `${value}%` }} />
    </div>
  );
}

/** Small pass/fail pill for the run-identity header. */
function RunStatusBadge({ run }: { run: EvalSuiteRun }) {
  const outcome = run.result ?? run.status;
  const label =
    outcome === "passed"
      ? "Passed"
      : outcome === "failed"
        ? "Failed"
        : outcome === "running"
          ? "Running"
          : outcome === "cancelled"
            ? "Cancelled"
            : "Pending";
  const tone =
    outcome === "passed"
      ? "bg-success/15 text-success"
      : outcome === "failed"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  );
}

// ─── Rail items ──────────────────────────────────────────────────────────────

function PinnedItem({
  icon,
  title,
  subtitle,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
          active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted",
        )}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left transition-colors",
        active ? "border-primary/40 bg-primary/[0.06]" : "border-transparent hover:bg-muted/60",
      )}
    >
      <span className="shrink-0 text-foreground">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {subtitle ? <div className="text-[11px] text-muted-foreground">{subtitle}</div> : null}
      </div>
    </button>
  );
}

function RunGroupItem({
  group,
  iterationsByRun,
  hostNamesById,
  prevPassRate,
  active,
  collapsed,
  expanded,
  selectedRunId,
  onSelect,
  onToggleExpand,
  onRunClick,
  onDeleteGroup,
  onDeleteRun,
}: {
  group: RailGroup;
  iterationsByRun: Map<string, EvalIteration[]>;
  hostNamesById: Map<string, string | null>;
  prevPassRate: number | null;
  active: boolean;
  collapsed: boolean;
  expanded: boolean;
  /** The run currently open in the right pane, if it belongs to this group. */
  selectedRunId?: string | null;
  onSelect: () => void;
  onToggleExpand: () => void;
  onRunClick: (runId: string) => void;
  /** Delete every run in this group (the whole launch). */
  onDeleteGroup?: () => void;
  /** Delete a single host run within an expanded group. */
  onDeleteRun?: (runId: string) => void;
}) {
  const rate = group.passRate;
  const delta = rate == null || prevPassRate == null ? null : rate - prevPassRate;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onSelect}
        title={`${group.label} · ${rate ?? "—"}% · ${group.hostCount} host${group.hostCount > 1 ? "s" : ""} · ${formatRelativeTime(group.timestamp)}`}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
          active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted",
        )}
      >
        <span className={cn("h-2.5 w-2.5 rounded-full", rate == null ? "bg-muted-foreground/40" : toneFor(rate))} />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "group/run rounded-md border",
        active ? "border-primary/40 bg-primary/[0.06]" : "border-transparent hover:bg-muted/60",
      )}
    >
      <div className="flex items-stretch">
        {!group.isStandalone ? (
          <button
            type="button"
            onClick={onToggleExpand}
            title={expanded ? "Hide host runs" : "Show host runs"}
            className="flex w-7 shrink-0 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="w-7 shrink-0" />
        )}
        <button type="button" onClick={onSelect} className="flex-1 py-2.5 pr-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs font-medium text-foreground">{group.label}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatRelativeTime(group.timestamp)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            {rate == null ? (
              <span className="text-xs text-muted-foreground">pending</span>
            ) : (
              <>
                <Sparkbar value={rate} />
                <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-foreground">
                  {rate}%
                </span>
              </>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {group.hostCount} host{group.hostCount > 1 ? "s" : ""}
            </span>
            {delta != null && delta !== 0 ? (
              <span
                className={cn(
                  "flex items-center gap-0.5 text-[11px] font-medium tabular-nums",
                  delta < 0 ? "text-destructive" : "text-success",
                )}
              >
                {delta < 0 ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                {delta > 0 ? "+" : ""}
                {delta} pts
              </span>
            ) : null}
          </div>
        </button>
        {onDeleteGroup ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteGroup();
            }}
            title={group.isStandalone ? "Delete run" : "Delete run group"}
            aria-label={group.isStandalone ? "Delete run" : "Delete run group"}
            className="flex w-7 shrink-0 items-center justify-center rounded-r-md text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {expanded && !group.isStandalone ? (
        <div className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
          {group.runs.map((run) => {
            const childRate = computeRunEffectiveStats(run, iterationsByRun.get(run._id) ?? []).passRate;
            const hostName = run.namedHostId
              ? hostNamesById.get(run.namedHostId) ?? formatRunId(run.namedHostId)
              : formatRunId(run._id);
            const runActive = selectedRunId === run._id;
            return (
              <div
                key={run._id}
                className={cn(
                  "group/child flex items-center gap-1 rounded transition-colors",
                  runActive ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-muted",
                )}
              >
                <button
                  type="button"
                  onClick={() => onRunClick(run._id)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1"
                  title={`Open run ${formatRunId(run._id)}`}
                >
                  <HostChip
                    name={hostName}
                    hostId={run.namedHostId}
                    className="max-w-[130px] gap-1 px-2 py-0.5 text-[10px] shadow-none"
                  />
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">{formatRunId(run._id)}</span>
                    {childRate != null ? (
                      <span className={cn("text-[11px] font-medium tabular-nums", textToneFor(childRate))}>
                        {childRate}%
                      </span>
                    ) : null}
                  </span>
                </button>
                {onDeleteRun ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRun(run._id);
                    }}
                    title="Delete run"
                    aria-label={`Delete run ${formatRunId(run._id)}`}
                    className="flex w-6 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

type View =
  | { kind: "all" }
  | { kind: "group"; key: string }
  | { kind: "monitoring" }
  | { kind: "compare" }
  | { kind: "run" };

export function SuiteResultsSplit({
  suite,
  cases,
  runs,
  allIterations,
  hostNamesById,
  allRunsPane,
  onTestCaseClick,
  onOpenCaseIteration,
  onRunClick,
  showMonitoring = false,
  selectedRunId,
  runDetailPane,
  onExitRun,
  onDeleteRun,
  onDeleteTestCasesBatch,
  onGroupScopeChange,
}: SuiteResultsSplitProps) {
  const [internalView, setInternalView] = useState<View>({ kind: "all" });
  // Pending run deletion (single run or whole group), confirmed via dialog.
  const [deleteTarget, setDeleteTarget] = useState<{
    ids: string[];
    label: string;
  } | null>(null);
  const [isDeletingRuns, setIsDeletingRuns] = useState(false);
  const [caseRowSort, setCaseRowSort] = usePersistedState<CaseRowSort>(
    CASE_ROW_SORT_STORAGE_KEY,
    "suite-order",
  );

  const confirmDeleteRuns = async () => {
    if (!deleteTarget || !onDeleteRun) return;
    setIsDeletingRuns(true);
    try {
      for (const id of deleteTarget.ids) {
        await onDeleteRun(id);
      }
      toast.success(
        deleteTarget.ids.length > 1
          ? `Deleted ${deleteTarget.ids.length} runs`
          : "Run deleted",
      );
      // If the open run was deleted, leave it so the URL stops pointing at it.
      if (selectedRunId && deleteTarget.ids.includes(selectedRunId)) {
        onExitRun?.();
      }
      setDeleteTarget(null);
    } catch (error) {
      console.error("Failed to delete run(s):", error);
      toast.error("Failed to delete run");
    } finally {
      setIsDeletingRuns(false);
    }
  };

  // A matrix cell is one (case, host) result → open its iteration's replay.
  // Falls back to the case itself when the cell carries no iteration. Returns
  // undefined when no handler is wired, which makes the matrix cells inert.
  const handleCellOpen = onOpenCaseIteration
    ? (cell: { iterations: EvalIteration[] }, _hostId: string, caseId: string) => {
        const iteration = cell.iterations[0];
        if (iteration) onOpenCaseIteration(caseId, iteration._id);
        else onTestCaseClick(caseId);
      }
    : undefined;
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The URL owns "am I viewing a run". When a run is selected it overrides the
  // internal view; otherwise the rail's own selection (all / group / compare /
  // monitoring) drives the pane.
  const view: View = selectedRunId ? { kind: "run" } : internalView;

  // Navigate to a non-run destination. If a run is currently open, leave it
  // (clears the URL run id) so the rail selection becomes authoritative.
  const goTo = (next: View) => {
    setInternalView(next);
    if (selectedRunId) onExitRun?.();
  };

  const iterationsByRun = useMemo(() => {
    const map = new Map<string, EvalIteration[]>();
    for (const iter of allIterations) {
      if (!iter.suiteRunId) continue;
      const list = map.get(iter.suiteRunId);
      if (list) list.push(iter);
      else map.set(iter.suiteRunId, [iter]);
    }
    return map;
  }, [allIterations]);

  // Group runs by runGroupId; single-member groups + ungrouped runs are
  // standalone. Newest-first.
  const railGroups = useMemo<RailGroup[]>(() => {
    const byGroup = new Map<string, EvalSuiteRun[]>();
    const standalones: EvalSuiteRun[] = [];
    for (const run of runs) {
      if (run.runGroupId) {
        const list = byGroup.get(run.runGroupId);
        if (list) list.push(run);
        else byGroup.set(run.runGroupId, [run]);
      } else {
        standalones.push(run);
      }
    }

    const aggregate = (groupRuns: EvalSuiteRun[]): number | null => {
      let passed = 0;
      let total = 0;
      for (const run of groupRuns) {
        const stats = computeRunEffectiveStats(run, iterationsByRun.get(run._id) ?? []);
        passed += stats.effectivePassed;
        total += stats.effectiveTotal;
      }
      return total > 0 ? Math.round((passed / total) * 100) : null;
    };
    const distinctHosts = (groupRuns: EvalSuiteRun[]): number => {
      const set = new Set(groupRuns.map((r) => r.namedHostId).filter(Boolean));
      return set.size || 1;
    };

    const nodes: RailGroup[] = [];
    for (const [groupId, groupRuns] of byGroup) {
      if (groupRuns.length < 2) {
        standalones.push(...groupRuns);
        continue;
      }
      const sorted = [...groupRuns].sort((a, b) => runTimestamp(b) - runTimestamp(a));
      nodes.push({
        key: groupId,
        label: `Run group g${groupId.slice(0, 4)}`,
        isStandalone: false,
        runs: sorted,
        timestamp: sorted.reduce((m, r) => Math.max(m, runTimestamp(r)), 0),
        passRate: aggregate(sorted),
        hostCount: distinctHosts(sorted),
      });
    }
    for (const run of standalones) {
      nodes.push({
        key: run._id,
        label: `Run ${formatRunId(run._id)}`,
        isStandalone: true,
        runs: [run],
        timestamp: runTimestamp(run),
        passRate: aggregate([run]),
        hostCount: distinctHosts([run]),
      });
    }
    return nodes.sort((a, b) => b.timestamp - a.timestamp);
  }, [runs, iterationsByRun]);

  const activeGroup =
    view.kind === "group" ? railGroups.find((g) => g.key === view.key) ?? null : null;

  const selectedRun =
    selectedRunId ? runs.find((r) => r._id === selectedRunId) ?? null : null;

  // Scope iterations + runs to the selected group for the read-only snapshot.
  const scoped = useMemo(() => {
    if (!activeGroup) return null;
    const runIds = new Set(activeGroup.runs.map((r) => r._id));
    const iters = allIterations.filter((i) => i.suiteRunId && runIds.has(i.suiteRunId));
    return { runs: activeGroup.runs, iterations: iters };
  }, [activeGroup, allIterations]);

  // Report the selected multi-host group up so the dashboard insight banner can
  // render cross-host diagnosis for it. Keyed on a stable string so we only
  // notify when the meaningful scope changes, not on every render.
  const groupScopeRunIds =
    view.kind === "group" && activeGroup && activeGroup.runs.length >= 2
      ? activeGroup.runs.map((r) => r._id).join(",")
      : null;
  const groupScopeKey =
    groupScopeRunIds != null && activeGroup
      ? `${suite._id}:${activeGroup.key}:${groupScopeRunIds}`
      : null;
  useEffect(() => {
    if (!onGroupScopeChange) return;
    if (groupScopeKey && activeGroup) {
      onGroupScopeChange({
        suiteId: suite._id,
        runGroupId: activeGroup.key,
        runs: activeGroup.runs,
      });
    } else {
      onGroupScopeChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupScopeKey, onGroupScopeChange]);

  // The rail group that contains the selected run — auto-expanded + highlighted.
  const selectedRunGroupKey = useMemo(() => {
    if (!selectedRunId) return null;
    return railGroups.find((g) => g.runs.some((r) => r._id === selectedRunId))?.key ?? null;
  }, [selectedRunId, railGroups]);

  const isExpanded = (key: string): boolean =>
    expanded.has(key) || key === selectedRunGroupKey;

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const header =
    view.kind === "all"
      ? "All runs · trends per client"
      : view.kind === "monitoring"
        ? "Monitoring"
        : view.kind === "compare"
          ? "Compare runs"
          : activeGroup?.label ?? "Run group";

  const showsCrossHostMatrix =
    view.kind === "all"
      ? (suite.hostAttachments?.length ?? 0) >= 1 && runs.length > 0
      : view.kind === "group" && scoped != null;

  const canCompare = railGroups.length >= 2;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
      {/* ── Left rail ── */}
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-border/60 bg-muted/20 transition-[width]",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          {collapsed ? null : (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Runs</span>
              <span className="text-xs tabular-nums text-muted-foreground/70">{railGroups.length}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand runs" : "Collapse runs"}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        <div className={cn("flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2", collapsed ? "items-center px-2" : "px-2")}>
          <PinnedItem
            icon={<Layers className="h-4 w-4" />}
            title="All runs"
            subtitle="latest + trends per client"
            active={view.kind === "all"}
            collapsed={collapsed}
            onClick={() => goTo({ kind: "all" })}
          />
          <div className={cn("my-1 h-px shrink-0 bg-border/60", collapsed ? "w-8" : "w-full")} />
          {railGroups.map((group, i) => {
            // A standalone item IS a single run → selecting it opens run detail.
            // A multi-host group → selecting it opens the scoped cross-host grid;
            // its child runs open run detail individually.
            const standaloneRunId = group.isStandalone ? group.runs[0]?._id : null;
            const active = group.isStandalone
              ? selectedRunId === standaloneRunId
              : view.kind === "group" && view.key === group.key;
            return (
              <RunGroupItem
                key={group.key}
                group={group}
                iterationsByRun={iterationsByRun}
                hostNamesById={hostNamesById}
                prevPassRate={railGroups[i + 1]?.passRate ?? null}
                active={active}
                collapsed={collapsed}
                expanded={isExpanded(group.key)}
                selectedRunId={selectedRunId}
                onSelect={
                  group.isStandalone && standaloneRunId
                    ? () => onRunClick(standaloneRunId)
                    : () => goTo({ kind: "group", key: group.key })
                }
                onToggleExpand={() => toggleExpand(group.key)}
                onRunClick={onRunClick}
                onDeleteGroup={
                  onDeleteRun
                    ? () =>
                        setDeleteTarget({
                          ids: group.runs.map((r) => r._id),
                          label: group.isStandalone
                            ? formatRunId(group.runs[0]?._id ?? group.key)
                            : group.label,
                        })
                    : undefined
                }
                onDeleteRun={
                  onDeleteRun
                    ? (runId) =>
                        setDeleteTarget({
                          ids: [runId],
                          label: formatRunId(runId),
                        })
                    : undefined
                }
              />
            );
          })}
        </div>

        <div className="border-t border-border/60 p-2">
          {showMonitoring ? (
            <PinnedItem
              icon={<Activity className="h-4 w-4" />}
              title="Monitoring"
              active={view.kind === "monitoring"}
              collapsed={collapsed}
              onClick={() => goTo({ kind: "monitoring" })}
            />
          ) : null}
          <button
            type="button"
            disabled={!canCompare}
            onClick={() => goTo({ kind: "compare" })}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
              collapsed && "justify-center",
              !canCompare
                ? "text-muted-foreground/40"
                : view.kind === "compare"
                  ? "bg-primary/10 text-foreground ring-1 ring-primary/40"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={canCompare ? "Compare two runs" : "Need at least two runs"}
          >
            <GitCompareArrows className="h-4 w-4 shrink-0" />
            {collapsed ? null : <span>Compare runs</span>}
          </button>
        </div>
      </aside>

      {/* ── Right pane ── */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compare owns its own header (the pickers). */}
        {view.kind === "run" && selectedRun ? (
          // Slim run-identity header — the run's KPIs live in the shared metric
          // strip above, so this just names the run + status + host.
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <span className="font-mono text-sm font-semibold text-foreground">
              Run {formatRunId(selectedRun._id)}
            </span>
            <RunStatusBadge run={selectedRun} />
            {selectedRun.namedHostId ? (
              <HostChip
                name={
                  hostNamesById.get(selectedRun.namedHostId) ??
                  formatRunId(selectedRun.namedHostId)
                }
                hostId={selectedRun.namedHostId}
                className="gap-1 px-2 py-0.5 text-[11px] shadow-none"
              />
            ) : null}
          </div>
        ) : view.kind !== "compare" ? (
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-foreground">
                {view.kind === "monitoring" ? "Monitoring" : "Cases"}
              </span>
              {view.kind !== "monitoring" ? (
                <>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs font-medium text-muted-foreground">{header}</span>
                </>
              ) : null}
            </div>
            {view.kind !== "monitoring" ? (
              <div className="flex items-center gap-2">
                {showsCrossHostMatrix ? (
                  <CaseRowSortControl
                    value={caseRowSort}
                    onChange={setCaseRowSort}
                    showLabel
                  />
                ) : null}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {cases.length} cases
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {view.kind === "run" ? (
            runDetailPane ?? (
              <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
                Run detail unavailable.
              </div>
            )
          ) : view.kind === "all" ? (
            // Same cross-host matrix as a group view, across ALL runs (latest
            // per host + historical columns). Falls back to the authoring case
            // list when there's no host-scoped run data yet (no attachments or
            // no runs), so empty states + add/edit survive on legacy/fresh suites.
            (suite.hostAttachments?.length ?? 0) >= 1 && runs.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <CrossHostDashboard
                  suite={suite}
                  cases={cases}
                  runs={runs}
                  allIterations={allIterations}
                  expanded
                  cellTrends
                  caseRowSort={caseRowSort}
                  onCaseRowSortChange={setCaseRowSort}
                  sortControlInHeader
                  onTestCaseClick={onTestCaseClick}
                  onCellOpen={handleCellOpen}
                  onDeleteTestCasesBatch={onDeleteTestCasesBatch}
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {allRunsPane}
              </div>
            )
          ) : view.kind === "monitoring" ? (
            <MonitoringTab suiteId={suite._id} onRunClick={onRunClick} />
          ) : view.kind === "compare" ? (
            <SuiteGroupCompare
              groups={railGroups.map((g) => ({ key: g.key, label: g.label, runs: g.runs }))}
              hostNamesById={hostNamesById}
              onBack={() => goTo({ kind: "all" })}
              onOpenRun={onRunClick}
            />
          ) : scoped && activeGroup ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <GroupCrossHostDashboard
                suite={suite}
                cases={cases}
                runs={scoped.runs}
                allIterations={scoped.iterations}
                runGroupId={activeGroup.key}
                caseRowSort={caseRowSort}
                onCaseRowSortChange={setCaseRowSort}
                onTestCaseClick={onTestCaseClick}
                onCellOpen={handleCellOpen}
                onDeleteTestCasesBatch={onDeleteTestCasesBatch}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              No data for this run group.
            </div>
          )}
        </div>
      </section>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open && !isDeletingRuns) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Delete {(deleteTarget?.ids.length ?? 0) > 1 ? "run group" : "run"}
            </DialogTitle>
            <DialogDescription>
              {(deleteTarget?.ids.length ?? 0) > 1
                ? `Delete ${deleteTarget?.ids.length} runs in ${deleteTarget?.label}? This cannot be undone.`
                : `Delete run ${deleteTarget?.label}? This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeletingRuns}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              onClick={confirmDeleteRuns}
              disabled={isDeletingRuns}
            >
              {isDeletingRuns ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
