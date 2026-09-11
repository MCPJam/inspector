import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { toTrialCardViews } from "./stage-trial-model";
import { TrialChainPanel } from "./trial-chain-panel";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isTerminalEvalRunStatus } from "@/lib/evals/eval-decision-summary-store";
import { ArrowUpRight, ChevronRight, Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import { cn } from "@mcpjam/design-system/cn";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import {
  formatCostOrDash,
  iterationLatencyP50,
  iterationLatencyP95,
} from "../evals/helpers";
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
  type RunResultsMatrixData,
} from "./run-results-matrix-model";

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
const outcomeTone = (result: string) =>
  result === "passed"
    ? "bg-success/15 text-foreground border-success/40"
    : result === "failed" || result === "timed_out"
      ? "bg-destructive/10 text-foreground border-destructive/40"
      : "bg-muted/40 text-foreground border-border";

function CellMetrics({ items }: { items: EvalIteration[] }) {
  const counts = resultCounts(items);
  const tokens = items.filter((item) => item.tokensUsed != null);
  const calls = items.filter((item) => item.actualToolCalls != null);
  const status = counts.pending
    ? "Running"
    : counts.failed
      ? "Fail"
      : counts.cancelled
        ? "Cancelled"
        : "Pass";
  const statusTone = counts.pending
    ? "text-pending"
    : counts.failed
      ? "text-destructive"
      : counts.cancelled
        ? "text-muted-foreground"
        : "text-success";
  const breakdown = `${counts.passed} passed, ${counts.failed} failed, ${counts.pending} in progress, ${counts.cancelled} cancelled`;
  const compact = (n: number) =>
    Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  const metricLabel =
    "block text-[9px] font-medium uppercase tracking-wide text-muted-foreground";
  return (
    <>
      <span className="w-full space-y-2">
        <span className="flex items-center justify-between gap-3 tabular-nums">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs font-semibold",
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
            className="shrink-0 text-[11px] text-muted-foreground"
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
      <span className="grid w-full grid-cols-3 divide-x divide-border/60 text-[11px] tabular-nums [&>span]:px-2 [&>span:first-child]:pl-0 [&>span:last-child]:pr-0">
        <span>
          <span className={metricLabel}>Latency</span>
          <span className="mt-1 block">
            <span className="text-[9px] text-muted-foreground">P50 </span>
            {formatRunCaseLatencyMs(iterationLatencyP50(items))}
          </span>
          <span className="mt-1 block">
            <span className="text-[9px] text-muted-foreground">P95 </span>
            {formatRunCaseLatencyMs(iterationLatencyP95(items))}
          </span>
        </span>
        <span>
          <span className={metricLabel}>Tokens</span>
          <span className="mt-1 block font-medium">
            {tokens.length
              ? compact(
                  tokens.reduce((sum, item) => sum + (item.tokensUsed ?? 0), 0),
                )
              : "—"}
          </span>
        </span>
        <span>
          <span className={metricLabel}>Tool calls</span>
          <span className="mt-1 block font-medium">
            {calls.length
              ? compact(
                  calls.reduce(
                    (sum, item) => sum + (item.actualToolCalls?.length ?? 0),
                    0,
                  ),
                )
              : "—"}
          </span>
        </span>
      </span>
    </>
  );
}

export function RunResultsMatrix({
  run,
  runs = [],
  iterations,
  hostNamesById = new Map(),
  diagnostics = [],
  chains,
  onOpenIteration,
  modelIds,
  toolbarExtra,
  extraFiltersActive = false,
  onClearExtraFilters,
}: {
  modelIds?: readonly string[];
  run: EvalSuiteRun;
  runs?: readonly EvalSuiteRun[];
  iterations: readonly EvalIteration[];
  hostNamesById?: ReadonlyMap<string, string | null>;
  diagnostics?: readonly EvalRunDecisionDiagnostic[];
  chains?: ReadonlyMap<string, EvalRunDecisionChain>;
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  toolbarExtra?: ReactNode;
  extraFiltersActive?: boolean;
  onClearExtraFilters?: () => void;
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
  const showPending = [run, ...runs].some(
    (item) => !isTerminalEvalRunStatus(item.status),
  );
  const counts = resultCounts(
    data.targets.flatMap((target) => target.iterations),
  );
  const statusOptions = (
    ["failed", "passed", "pending", "cancelled"] as const
  ).filter((value) =>
    value === "pending"
      ? showPending
      : value === "cancelled"
        ? counts.cancelled > 0
        : true,
  );
  useEffect(() => {
    if (status === "pending" && !showPending) setStatus(ALL_EVAL_FILTER_VALUES);
    if (status === "cancelled" && counts.cancelled === 0)
      setStatus(ALL_EVAL_FILTER_VALUES);
  }, [showPending, status, counts.cancelled]);
  const [selection, setSelection] = useState<{
    caseKey: string;
    targetKey: string;
  } | null>(null);
  const activeStatus =
    status === "pending" && !showPending
      ? ALL_EVAL_FILTER_VALUES
      : status === "cancelled" && counts.cancelled === 0
        ? ALL_EVAL_FILTER_VALUES
        : status;
  const query = search.trim().toLowerCase();
  const rows = data.rows.filter(
    (row) =>
      row.title.toLowerCase().includes(query) &&
      (activeStatus === ALL_EVAL_FILTER_VALUES ||
        data.targets.some(
          (target) =>
            resultCounts(target.cells.get(row.key) ?? [])[
              activeStatus as StatusFilter
            ] > 0,
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

  return (
    <section
      className="space-y-4 px-5 py-5"
      aria-label="Test case results"
      data-testid="run-results-matrix"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-lg font-semibold tracking-tight">
          Test cases{" "}
          <span className="ml-1 font-mono text-sm font-normal text-muted-foreground">
            {data.rows.length}
          </span>
        </h3>
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
                      src={resolveHostLogoByName(target.client, theme)}
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
                      {target.counts.passed}
                      <span className="text-muted-foreground">
                        /{target.iterations.length}
                      </span>
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
                  className="sticky left-0 z-10 bg-card p-4 align-top font-medium"
                >
                  <span className="block break-words text-[13px] leading-5">
                    {row.title}
                  </span>
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
                          onClick={() =>
                            setSelection({
                              caseKey: row.key,
                              targetKey: target.key,
                            })
                          }
                          aria-label={`Inspect ${row.title} on ${target.client} · ${target.model}`}
                          className="flex h-full min-h-28 w-full flex-col gap-3 px-3 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <CellMetrics items={items} />
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
          if (!open) setSelection(null);
        }}
      >
        <SheetContent className="w-full gap-0 sm:max-w-4xl">
          {selectedRow && selectedTarget && (
            <>
              <SheetHeader className="border-b border-border px-6 py-5 pr-12">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Case report
                </div>
                <SheetTitle className="break-words text-xl">
                  {selectedRow.title}
                </SheetTitle>
                <SheetDescription>
                  Inspect iteration results and follow the recorded stages to
                  their evidence.
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-6">
                <div
                  className="mb-4 flex flex-wrap items-center gap-2"
                  aria-label="Viewing client and model"
                >
                  <span className="mr-1 text-xs text-muted-foreground">
                    Viewing client
                  </span>
                  {data.targets.map((target) => (
                    <Button
                      key={target.key}
                      size="sm"
                      className="h-auto rounded-full whitespace-normal px-3 py-1.5 text-left"
                      variant={
                        target.key === selectedTarget.key
                          ? "secondary"
                          : "outline"
                      }
                      aria-pressed={target.key === selectedTarget.key}
                      onClick={() =>
                        setSelection({
                          caseKey: selectedRow.key,
                          targetKey: target.key,
                        })
                      }
                    >
                      {target.client} · {target.model}
                    </Button>
                  ))}
                </div>
                <CaseIterations
                  target={selectedTarget}
                  diagnostics={diagnostics}
                  chains={chains}
                  caseKey={selectedRow.key}
                  onOpenIteration={onOpenIteration}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function CaseIterations({
  target,
  caseKey,
  diagnostics,
  chains,
  onOpenIteration,
}: {
  target: RunResultsMatrixData["targets"][number];
  caseKey: string;
  diagnostics: readonly EvalRunDecisionDiagnostic[];
  chains?: ReadonlyMap<string, EvalRunDecisionChain>;
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
}) {
  const items = target.cells.get(caseKey) ?? [];
  const counts = resultCounts(items);
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
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-foreground/30 px-4 py-3">
        <div>
          <span className="font-mono text-2xl font-semibold tracking-tight">
            {counts.passed}/{items.length}
          </span>
          <span className="ml-2 text-sm text-muted-foreground">
            iterations passed
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          p95 {formatRunCaseLatencyMs(iterationLatencyP95(items))}
        </span>
      </div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Iterations · failures first
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[580px]">
          <div
            className="grid grid-cols-[16px_36px_90px_minmax(110px,1fr)_60px_72px_40px] items-center gap-3 bg-muted/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            aria-hidden="true"
          >
            <span />
            <span>Iter</span>
            <span>Result</span>
            <span>User Value Chain</span>
            <span>Latency</span>
            <span>Tokens</span>
            <span>Calls</span>
          </div>
          {sorted.map(({ item, index }) => (
            <details
              key={item._id}
              className="group border-t border-border"
              open={sorted[0]?.item._id === item._id}
            >
              <summary className="grid cursor-pointer list-none grid-cols-[16px_36px_90px_minmax(110px,1fr)_60px_72px_40px] items-center gap-3 px-4 py-3 text-xs hover:bg-muted/30 group-open:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 text-muted-foreground group-open:rotate-90" />
                <span className="font-mono text-muted-foreground">
                  #{item.iterationNumber ?? index + 1}
                </span>
                <span
                  className={cn(
                    "w-fit rounded border px-2 py-0.5",
                    outcomeTone(computeIterationResult(item)),
                  )}
                >
                  {outcomeLabel(computeIterationResult(item))}
                </span>
                <IterationStageStrip
                  chain={
                    diagnostics.find(
                      (diagnostic) => diagnostic.iterationId === item._id,
                    )?.chain ?? chains?.get(item._id)
                  }
                />
                <span className="tabular-nums text-muted-foreground">
                  {formatRunCaseLatencyMs(iterationLatencyP95([item]))}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {typeof item.tokensUsed === "number"
                    ? item.tokensUsed.toLocaleString()
                    : "—"}
                </span>
                <span className="text-muted-foreground">
                  {item.actualToolCalls?.length ?? "—"}
                </span>
              </summary>
              <div className="space-y-4 border-t border-border bg-muted/20 p-4 text-xs leading-relaxed">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">Iteration details</span>
                  {onOpenIteration && item.testCaseId && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() =>
                        onOpenIteration({
                          testCaseId: item.testCaseId!,
                          iterationId: item._id,
                        })
                      }
                    >
                      Open details <ArrowUpRight className="size-3.5" />
                    </Button>
                  )}
                </div>
                <TrialChainPanel
                  layout="report"
                  chain={
                    diagnostics.find(
                      (diagnostic) => diagnostic.iterationId === item._id,
                    )?.chain ?? chains?.get(item._id)
                  }
                  nextAction={
                    diagnostics.find(
                      (diagnostic) => diagnostic.iterationId === item._id,
                    )?.nextAction
                  }
                  resetKey={item._id}
                />
                {item.error && (
                  <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3">
                    {item.error}
                  </p>
                )}
                <div>
                  <span className="font-medium">Prompt</span>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {item.testCaseSnapshot?.query || "No prompt recorded."}
                  </p>
                </div>
                <div>
                  <span className="font-medium">Observed tool calls</span>
                  <p className="mt-1 break-words font-mono text-muted-foreground">
                    {item.actualToolCalls
                      ?.map((call) => call.toolName)
                      .join(" → ") || "No tool calls recorded."}
                  </p>
                </div>
              </div>
            </details>
          ))}
        </div>
        <p className="border-t border-border bg-muted/30 px-4 py-2 text-[10px] text-muted-foreground">
          Failures first · showing {items.length} recorded iterations · select a
          stage to inspect evidence
        </p>
      </div>
      {!items.length && (
        <p className="py-6 text-sm text-muted-foreground">
          No recorded iterations for this case on this client and model.
        </p>
      )}
    </>
  );
}

function IterationStageStrip({
  chain,
}: {
  chain?: EvalRunDecisionChain | null;
}) {
  if (!chain || chain.status !== "verified") {
    return (
      <span className="text-[10px] text-muted-foreground">
        {chain?.status === "unverified" ? "Chain withheld" : "Not recorded"}
      </span>
    );
  }
  return (
    <span className="flex gap-1" aria-label="Recorded stages">
      {toTrialCardViews(chain.stages).map((card) => (
        <span
          key={card.stage}
          title={`${card.ordinal} ${card.label}: ${card.chip.label}`}
          aria-label={`${card.label}: ${card.chip.label}`}
          className={cn(
            "h-2.5 min-w-0 flex-1 rounded-sm border",
            card.chip.kind === "passed"
              ? "border-success/40 bg-success/60"
              : card.chip.kind === "failed"
                ? "border-destructive bg-destructive/20"
                : "border-dashed border-muted-foreground/40 bg-muted/30",
          )}
        />
      ))}
    </span>
  );
}
