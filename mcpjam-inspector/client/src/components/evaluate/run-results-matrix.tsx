import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isTerminalEvalRunStatus } from "@/lib/evals/eval-decision-summary-store";
import { Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { cn } from "@mcpjam/design-system/cn";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import { resolveHostLogoByName } from "@/lib/host-logo";
import {
  average,
  compactMetric,
  formatCostOrDash,
  formatRelativeTime,
  formatRunId,
  iterationLatencyP50,
  iterationLatencyP95,
  runClientLogo,
  runClientIdentity,
} from "../evals/helpers";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import { computeIterationResult } from "../evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import {
  ALL_EVAL_FILTER_VALUES,
  EvalListFilter,
} from "../evals/eval-list-filter";
import { runHistoryFilterClass } from "../evals/run-history-table";
import {
  buildRunResultsMatrix,
  resultCounts,
  cellResult,
  type RunResultsMatrixData,
} from "./run-results-matrix-model";
import { IterationDetails } from "../evals/iteration-details";
import { IterationReportScorecard } from "./case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "./case-scorecard/trial-authored";

type StatusFilter = "failed" | "passed" | "pending" | "cancelled";
const STATUS_LABEL: Record<StatusFilter, string> = {
  failed: "Failures",
  passed: "Passed",
  pending: "Pending",
  cancelled: "Cancelled",
};
const outcomeLabel = (result: string) =>
  ({
    passed: "Passed",
    failed: "Failed",
    pending: "In progress",
    cancelled: "Cancelled",
    timed_out: "Timed out",
  })[result] ?? "Unknown";
const outcomeTextTone = (result: string) =>
  result === "passed"
    ? "text-success"
    : result === "failed" || result === "timed_out"
      ? "text-destructive"
      : result === "pending"
        ? "text-pending"
        : "text-muted-foreground";

const outcomeDotTone = (result: string) =>
  result === "passed"
    ? "bg-success"
    : result === "failed" || result === "timed_out"
      ? "bg-destructive"
      : result === "pending"
        ? "bg-pending"
        : "bg-muted-foreground";

type MatrixView = "results" | "metrics";

function CellResults({ items }: { items: EvalIteration[] }) {
  const counts = resultCounts(items);
  const result = cellResult(items);
  const status =
    result === "pending"
      ? "Running"
      : result === "failed"
        ? "Fail"
        : result === "cancelled"
          ? "Cancelled"
          : "Pass";
  const statusTone = outcomeTextTone(result ?? "passed");
  const breakdown = `${counts.passed} passed, ${counts.failed} failed, ${counts.pending} in progress, ${counts.cancelled} cancelled`;
  return (
    <span className="w-full space-y-2">
      <span className="flex items-center justify-between gap-3 tabular-nums">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-[12px] font-semibold",
              statusTone,
            )}
          >
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-current"
            />
            {status}
          </span>
        </span>
        <span
          className="shrink-0 text-lg font-semibold leading-6 text-card-foreground"
          aria-label={`${counts.passed} of ${items.length} iterations passed`}
        >
          {counts.passed}/{items.length}
        </span>
      </span>
      <span
        role="img"
        aria-label={breakdown}
        title={breakdown}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {(["passed", "failed", "pending", "cancelled"] as const).map(
          (outcome) =>
            counts[outcome] > 0 && (
              <span
                key={outcome}
                aria-hidden="true"
                className={cn(
                  outcome === "passed"
                    ? "bg-success"
                    : outcome === "failed"
                      ? "bg-destructive"
                      : outcome === "pending"
                        ? "bg-pending"
                        : "bg-muted-foreground/40",
                )}
                style={{
                  width: `${(counts[outcome] / items.length) * 100}%`,
                }}
              />
            ),
        )}
      </span>
    </span>
  );
}

function CellMetricValues({ items }: { items: EvalIteration[] }) {
  const tokenAverage = average(
    items.flatMap((item) =>
      typeof item.tokensUsed === "number" ? [item.tokensUsed] : [],
    ),
  );
  const callAverage = average(
    items.flatMap((item) =>
      item.actualToolCalls ? [item.actualToolCalls.length] : [],
    ),
  );
  const metricLabel =
    "text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-muted-foreground";
  const metric = "flex min-w-0 flex-1 flex-col gap-0.5";
  const divider = "border-r border-border pr-2";
  return (
    <span className="flex min-h-16 w-full items-center tabular-nums">
      <span className={cn(metric, divider)}>
        <span className={metricLabel}>P50</span>
        <span className="text-base font-semibold leading-5">
          {formatRunCaseLatencyMs(iterationLatencyP50(items))}
        </span>
      </span>
      <span className={cn(metric, divider, "px-2")}>
        <span className={metricLabel}>P95</span>
        <span className="text-base font-semibold leading-5">
          {formatRunCaseLatencyMs(iterationLatencyP95(items))}
        </span>
      </span>
      {/* Both are the MEAN per iteration, not the case total — the heading has
          no room to say so, so the accessible name carries it. Reading these
          as totals would overstate a repeated case by its iteration count. */}
      <span
        className={cn(metric, divider, "px-2")}
        title="Average tokens per iteration"
      >
        <span className={metricLabel}>Tokens</span>
        <span
          className="text-base font-semibold leading-5"
          aria-label={
            tokenAverage === null
              ? "Tokens not recorded"
              : `${Math.round(tokenAverage).toLocaleString()} tokens per iteration on average`
          }
        >
          {tokenAverage === null ? "—" : compactMetric(tokenAverage)}
        </span>
      </span>
      <span
        className={cn(metric, "pl-2")}
        title="Average tool calls per iteration"
      >
        <span className={metricLabel}>Calls</span>
        <span
          className="text-base font-semibold leading-5"
          aria-label={
            callAverage === null
              ? "Tool calls not recorded"
              : `${callAverage.toFixed(1)} tool calls per iteration on average`
          }
        >
          {callAverage === null ? "—" : compactMetric(callAverage)}
        </span>
      </span>
    </span>
  );
}

export function RunResultsMatrix({
  run,
  runs = [],
  iterations,
  hostNamesById = new Map(),
  diagnostics = [],
  chains,
  suiteName,
  modelIds,
  toolbarExtra,
  extraFiltersActive = false,
  onClearExtraFilters,
  onFilterChange,
  onEditCase,
  onEditEvaluator,
}: {
  modelIds?: readonly string[];
  run: EvalSuiteRun;
  runs?: readonly EvalSuiteRun[];
  iterations: readonly EvalIteration[];
  hostNamesById?: ReadonlyMap<string, string | null>;
  diagnostics?: readonly EvalRunDecisionDiagnostic[];
  chains?: ReadonlyMap<string, EvalRunDecisionChain>;
  suiteName?: string;
  toolbarExtra?: ReactNode;
  extraFiltersActive?: boolean;
  onClearExtraFilters?: () => void;
  onFilterChange?: (filters: { search: string; status: string }) => void;
  onEditCase?: (testCaseId: string) => void;
  onEditEvaluator?: (testCaseId: string) => void;
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const data = useMemo(() => {
    const matrix = buildRunResultsMatrix({
      run,
      runs,
      iterations,
      hostNamesById,
    });
    return {
      ...matrix,
      targets: modelIds
        ? matrix.targets.filter((target) => modelIds.includes(target.modelId))
        : matrix.targets,
    };
  }, [run, runs, iterations, hostNamesById, modelIds]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(ALL_EVAL_FILTER_VALUES);
  const [view, setView] = useState<MatrixView>("results");
  const showPending = [run, ...runs].some(
    (item) => !isTerminalEvalRunStatus(item.status),
  );
  const counts = resultCounts(
    data.targets.flatMap((target) => target.iterations),
  );
  const query = search.trim().toLowerCase();
  const statusOptions = (["failed", "passed", "pending", "cancelled"] as const)
    .filter((value) =>
      value === "pending"
        ? showPending
        : value === "cancelled"
          ? counts.cancelled > 0
          : true,
    )
    .filter((value) =>
      data.rows.some(
        (row) =>
          row.title.toLowerCase().includes(query) &&
          data.targets.some(
            (target) => cellResult(target.cells.get(row.key) ?? []) === value,
          ),
      ),
    );
  const activeStatus = statusOptions.includes(status as StatusFilter)
    ? status
    : ALL_EVAL_FILTER_VALUES;
  useEffect(() => {
    if (status !== activeStatus) setStatus(activeStatus);
  }, [status, activeStatus]);
  const [selection, setSelection] = useState<{
    caseKey: string;
    targetKey: string;
  } | null>(null);
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    onFilterChange?.({ search: query, status: activeStatus });
  }, [query, activeStatus, onFilterChange]);
  const rows = data.rows.filter(
    (row) =>
      row.title.toLowerCase().includes(query) &&
      (activeStatus === ALL_EVAL_FILTER_VALUES ||
        data.targets.some(
          (target) =>
            cellResult(target.cells.get(row.key) ?? []) === activeStatus,
        )),
  );
  const hasActiveFilters =
    Boolean(query) ||
    activeStatus !== ALL_EVAL_FILTER_VALUES ||
    extraFiltersActive;
  const clearFilters = () => {
    setSearch("");
    setStatus(ALL_EVAL_FILTER_VALUES);
    onClearExtraFilters?.();
  };
  const selectedRow = data.rows.find((row) => row.key === selection?.caseKey);
  const selectedTarget = data.targets.find(
    (target) => target.key === selection?.targetKey,
  );
  const selectedItems =
    selectedRow && selectedTarget
      ? (selectedTarget.cells.get(selectedRow.key) ?? [])
      : [];
  const selectedIteration =
    selectedItems.find((item) => item._id === selectedIterationId) ?? null;

  return (
    <section
      className="space-y-4 px-5 py-5"
      aria-label="Test case results"
      data-testid="run-results-matrix"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-4">
          <h3 className="text-lg font-semibold tracking-tight">
            <span className="tabular-nums">{data.rows.length}</span>{" "}
            {data.rows.length === 1 ? "Test case" : "Test cases"}
          </h3>
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => value && setView(value as MatrixView)}
            aria-label="Test case data view"
            className="gap-0.5 bg-muted p-0.5"
          >
            <ToggleGroupItem
              value="results"
              className="h-7 min-w-0 flex-none rounded-sm px-2.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-card-foreground data-[state=on]:shadow-sm first:rounded-sm last:rounded-sm"
            >
              Results
            </ToggleGroupItem>
            <ToggleGroupItem
              value="metrics"
              className="h-7 min-w-0 flex-none rounded-sm px-2.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-card-foreground data-[state=on]:shadow-sm first:rounded-sm last:rounded-sm"
            >
              Metrics
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="run-results-toolbar"
        >
          <div className="relative w-56 max-w-full">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className={cn(
                runHistoryFilterClass,
                "w-full max-w-none pl-8 md:text-[11px] dark:bg-card",
              )}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a test case…"
              aria-label="Find a test case"
            />
          </div>
          <EvalListFilter
            label="Status"
            className="w-32"
            value={activeStatus}
            options={[...statusOptions]}
            formatOption={(value) =>
              STATUS_LABEL[value as StatusFilter] ?? value
            }
            onChange={setStatus}
          />
          {toolbarExtra}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table
          className="w-full table-fixed border-collapse text-left text-xs"
          style={{ minWidth: 300 + data.targets.length * 280 }}
        >
          <caption className="sr-only">
            Test cases by client and model. Counts describe iterations, not case
            verdicts.
          </caption>
          <colgroup>
            <col className="w-[220px] sm:w-[300px]" />
            {data.targets.map((target) => (
              <col key={target.key} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card p-4 align-bottom font-medium"
              >
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Test case
                </span>
              </th>
              {data.targets.map((target) => (
                <th
                  scope="col"
                  key={target.key}
                  className="border-l border-border p-4 align-top font-normal"
                >
                  <div className="flex items-center gap-2 font-semibold text-foreground">
                    <img
                      src={
                        runClientLogo(target.run, theme) ??
                        resolveHostLogoByName(target.client, theme)
                      }
                      alt=""
                      className="size-5 object-contain"
                    />
                    {target.client}
                  </div>
                  <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {target.model}
                  </div>
                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="text-lg font-semibold tabular-nums">
                      {target.counts.passed}/{target.iterations.length}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      iters passed
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span>p95 {formatRunCaseLatencyMs(target.p95Ms)}</span>
                    <span
                      title={`${
                        target.cost.costedIterations
                      } iterations priced${
                        target.cost.hasRunnerReported
                          ? "; includes runner-reported cost"
                          : ""
                      }`}
                    >
                      {formatCostOrDash(target.cost.totalUsd)}
                      {target.cost.costedIterations > 0 &&
                      target.cost.costedIterations < target.iterations.length
                        ? " · partial"
                        : ""}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="group border-b border-border/60 last:border-0"
              >
                <th
                  scope="row"
                  className={cn(
                    "sticky left-0 z-10 bg-card p-0 align-top font-medium",
                    onEditCase && row.testCaseId && "hover:bg-muted/50",
                  )}
                >
                  {onEditCase && row.testCaseId ? (
                    <button
                      type="button"
                      className="block min-h-16 w-full break-words p-4 text-left text-[13px] leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-label={`Open test case: ${row.title}`}
                      onClick={() => onEditCase(row.testCaseId!)}
                    >
                      {row.title}
                    </button>
                  ) : (
                    <span className="block break-words p-4 text-[13px] leading-5">
                      {row.title}
                    </span>
                  )}
                </th>
                {data.targets.map((target) => {
                  const items = target.cells.get(row.key) ?? [];
                  return (
                    <td
                      key={target.key}
                      className="border-l border-border/60 p-0 align-top"
                    >
                      {items.length ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIterationId(null);
                            setSelection({
                              caseKey: row.key,
                              targetKey: target.key,
                            });
                          }}
                          aria-label={`Inspect ${row.title} on ${target.client} · ${target.model}`}
                          className={cn(
                            "flex h-full w-full flex-col px-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            view === "results"
                              ? "min-h-16 justify-center py-4"
                              : "min-h-16 justify-center py-3",
                          )}
                        >
                          {view === "results" ? (
                            <CellResults items={items} />
                          ) : (
                            <CellMetricValues items={items} />
                          )}
                        </button>
                      ) : (
                        <div className="p-4 text-muted-foreground">
                          —
                          <span className="mt-1 block text-[10px]">
                            {["running", "pending"].includes(target.run.status)
                              ? "Awaiting iterations"
                              : "No recorded iterations"}
                          </span>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            {data.rows.length
              ? "No cases match these filters."
              : "Waiting for the first test case results."}
          </div>
        )}
      </div>
      <Sheet
        open={Boolean(selectedRow && selectedTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
            setSelectedIterationId(null);
          }
        }}
      >
        <SheetContent className="w-full gap-0 sm:max-w-[960px]">
          {selectedRow &&
            selectedTarget &&
            (selectedIteration ? (
              <IterationDrawer
                iteration={selectedIteration}
                iterationNumber={
                  selectedIteration.iterationNumber ??
                  selectedItems.findIndex(
                    (item) => item._id === selectedIteration._id,
                  ) + 1
                }
                target={selectedTarget}
                caseTitle={selectedRow.title}
                suiteName={suiteName}
                diagnostic={diagnostics.find(
                  (item) => item.iterationId === selectedIteration._id,
                )}
                chain={chains?.get(selectedIteration._id)}
                onBack={() => setSelectedIterationId(null)}
                onEditEvaluator={
                  onEditEvaluator && selectedRow.testCaseId
                    ? () => {
                        setSelection(null);
                        setSelectedIterationId(null);
                        onEditEvaluator(selectedRow.testCaseId!);
                      }
                    : undefined
                }
              />
            ) : (
              <>
                <SheetHeader className="px-6 py-5 pr-12">
                  <SheetTitle className="break-words text-xl">
                    {selectedRow.title}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    Test case averages and recorded iterations.
                  </SheetDescription>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto p-6">
                  <div
                    className="mb-2 flex flex-wrap items-center justify-between gap-3"
                    aria-label="Viewing client and model"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                      Test case averages
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {data.targets.map((target) => (
                        <Button
                          key={target.key}
                          size="sm"
                          className="h-7 rounded-full px-2.5 text-xs"
                          variant={
                            target.key === selectedTarget.key
                              ? "secondary"
                              : "outline"
                          }
                          aria-pressed={target.key === selectedTarget.key}
                          onClick={() => {
                            setSelectedIterationId(null);
                            setSelection({
                              caseKey: selectedRow.key,
                              targetKey: target.key,
                            });
                          }}
                        >
                          {target.client} · {target.model}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <CaseIterations
                    target={selectedTarget}
                    caseKey={selectedRow.key}
                    onSelectIteration={setSelectedIterationId}
                  />
                  {onEditCase && selectedRow.testCaseId && (
                    <div className="mt-4 flex justify-end">
                      <Button
                        onClick={() => {
                          setSelection(null);
                          onEditCase(selectedRow.testCaseId!);
                        }}
                      >
                        Edit test case
                      </Button>
                    </div>
                  )}
                </div>
              </>
            ))}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function CaseIterations({
  target,
  caseKey,
  onSelectIteration,
}: {
  target: RunResultsMatrixData["targets"][number];
  caseKey: string;
  onSelectIteration: (iterationId: string) => void;
}) {
  const items = target.cells.get(caseKey) ?? [];
  if (!items.length) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No recorded iterations for this case on this client and model.
      </p>
    );
  }
  const counts = resultCounts(items);
  const tokenAverage = average(
    items.flatMap((item) =>
      typeof item.tokensUsed === "number" ? [item.tokensUsed] : [],
    ),
  );
  const callAverage = average(
    items.flatMap((item) =>
      item.actualToolCalls ? [item.actualToolCalls.length] : [],
    ),
  );
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rank = (item: EvalIteration) =>
        ["failed", "timed_out"].includes(computeIterationResult(item))
          ? 0
          : computeIterationResult(item) === "pending"
            ? 1
            : 2;
      return rank(a.item) - rank(b.item) || a.index - b.index;
    });
  const passTone = counts.pending
    ? "text-pending"
    : counts.passed === items.length
      ? "text-success"
      : counts.cancelled === items.length
        ? "text-muted-foreground"
        : "text-destructive";
  const metricLabel =
    "text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-muted-foreground";
  return (
    <>
      <div className="mb-4 flex w-full rounded-xl border border-border px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={metricLabel}>Passed</span>
          <span
            className={cn(
              "text-[28px] font-bold leading-8 tracking-[-0.03em] tabular-nums",
              passTone,
            )}
          >
            {counts.passed}/{items.length}
          </span>
        </div>
        <DrawerAverage label="P50">
          {formatRunCaseLatencyMs(iterationLatencyP50(items))}
        </DrawerAverage>
        <DrawerAverage label="P95">
          {formatRunCaseLatencyMs(iterationLatencyP95(items))}
        </DrawerAverage>
        <DrawerAverage label="Tokens">
          {tokenAverage === null ? "—" : compactMetric(tokenAverage)}
        </DrawerAverage>
        <DrawerAverage label="Calls">
          {callAverage === null ? "—" : compactMetric(callAverage)}
        </DrawerAverage>
      </div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Iterations
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[760px]">
          <div
            className="grid grid-cols-[minmax(130px,1fr)_minmax(180px,1fr)_120px_120px_110px_70px] items-center gap-2 bg-muted px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
            aria-hidden="true"
          >
            <span>Iteration</span>
            <span>Client / Model</span>
            <span>Result</span>
            <span>Latency</span>
            <span>Tokens</span>
            <span>Calls</span>
          </div>
          {sorted.map(({ item, index }) => {
            const result = computeIterationResult(item);
            const row = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      outcomeDotTone(result),
                    )}
                  />
                  <span className="text-[13px] font-medium text-card-foreground">
                    #{item.iterationNumber ?? index + 1}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {formatRelativeTime(
                      item.createdAt ?? item.startedAt ?? item.updatedAt,
                    )}
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13px] font-medium text-card-foreground">
                    {target.client}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {target.model}
                  </span>
                </span>
                <span
                  className={cn("text-xs font-medium", outcomeTextTone(result))}
                >
                  {outcomeLabel(result)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatRunCaseLatencyMs(iterationLatencyP95([item]))}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {typeof item.tokensUsed === "number"
                    ? compactMetric(item.tokensUsed)
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {item.actualToolCalls?.length ?? "—"}
                </span>
              </>
            );
            return (
              <button
                key={item._id}
                type="button"
                className="grid w-full grid-cols-[minmax(130px,1fr)_minmax(180px,1fr)_120px_120px_110px_70px] items-center gap-2 border-t border-border px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`Open iteration ${item.iterationNumber ?? index + 1} details`}
                onClick={() => onSelectIteration(item._id)}
              >
                {row}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function IterationDrawer({
  iteration,
  iterationNumber,
  target,
  caseTitle,
  suiteName,
  diagnostic,
  chain,
  onBack,
  onEditEvaluator,
}: {
  iteration: EvalIteration;
  iterationNumber: number;
  target: RunResultsMatrixData["targets"][number];
  caseTitle: string;
  suiteName?: string;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  onBack: () => void;
  onEditEvaluator?: () => void;
}) {
  const result = computeIterationResult(iteration);
  const authored = authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run: target.run,
    forceSnapshot: true,
  }).authored;
  const decisionChain = diagnostic?.chain ?? chain;

  return (
    <>
      <SheetHeader className="border-b border-border px-6 py-5 pr-12">
        <button
          type="button"
          className="w-fit text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label="Back to test case iterations"
        >
          {caseTitle} <span aria-hidden="true">›</span> Run #
          {target.run.runNumber}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="text-xl">
            #{iterationNumber} {suiteName ?? target.run.name ?? "Run"}
          </SheetTitle>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              result === "passed"
                ? "border-success/30 bg-success/10 text-success"
                : result === "failed" || result === "timed_out"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground",
            )}
          >
            {outcomeLabel(result)}
          </span>
        </div>
        <SheetDescription>
          {target.client} · {target.model} ·{" "}
          {formatRelativeTime(
            iteration.createdAt ?? iteration.startedAt ?? iteration.updatedAt,
          )}{" "}
          · {formatRunId(iteration._id)}
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <IterationDetails
          hostSnapshot={hostSnapshotFromStyle(
            runClientIdentity(target.run).hostStyle,
          )}
          iteration={iteration}
          testCase={null}
          layoutMode="full"
          trialVerdictWord={outcomeLabel(result)}
          scorecard={{
            render: (context) => (
              <>
                <IterationReportScorecard
                  authored={authored}
                  iteration={iteration}
                  steps={authored.steps}
                  chain={decisionChain}
                  envelope={context.envelope}
                  trace={context.trace}
                  scoresSection={context.scoresSection}
                  judgeHidden={context.judgeHidden}
                />
                {onEditEvaluator && (
                  <div className="mt-4 flex justify-end">
                    <Button onClick={onEditEvaluator}>
                      Configure test case evaluators
                    </Button>
                  </div>
                )}
              </>
            ),
          }}
        />
      </div>
    </>
  );
}

function DrawerAverage({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="text-[28px] font-bold leading-8 tracking-[-0.03em] text-card-foreground tabular-nums">
        {children}
      </span>
    </div>
  );
}
