import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import { formatRunId, runHostLabel } from "@/components/evals/helpers";
import { compactModelIdTail } from "@/lib/environment-label";
import { cn } from "@mcpjam/design-system/cn";
import { computeIterationResult } from "@/components/evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";

import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../../evals/eval-list-filter";

const modelName = (it: EvalIteration) =>
  it.testCaseSnapshot?.model || "Unknown model";
const duration = (it: EvalIteration) =>
  it.startedAt != null && it.updatedAt != null
    ? Math.max(0, it.updatedAt - it.startedAt)
    : null;
const seconds = (ms: number | null) =>
  ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
const age = (ts: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
};

export function CaseRunTimeline({
  caseTitle,
  suiteName,
  iterations,
  suiteRuns = [],
  hostNamesById,
  selectedIterationId,
  openIterationId,
  onSelect,
  live = false,
  liveVerdict,
  pendingRun,
  onSelectLive,
  children,
}: {
  caseTitle: string;
  suiteName?: string;
  iterations: EvalIteration[];
  suiteRuns?: EvalSuiteRun[];
  hostNamesById?: Map<string, string | null>;
  selectedIterationId: string | null;
  openIterationId?: string | null;
  onSelect: (iteration: EvalIteration) => void;
  live?: boolean;
  liveVerdict?: "Running" | "Passed" | "Failed" | "No verdict";
  pendingRun?: { model: string; client?: string };
  onSelectLive?: () => void;
  children: ReactNode;
}) {
  const [model, setModel] = useState(ALL_EVAL_FILTER_VALUES);
  const [client, setClient] = useState(ALL_EVAL_FILTER_VALUES);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (live) setDrawerOpen(true);
  }, [live]);
  useEffect(() => {
    if (openIterationId) setDrawerOpen(true);
  }, [openIterationId]);
  const runMetadata = useMemo(
    () =>
      new Map(
        iterations.map((it) => {
          const run = suiteRuns.find((run) => run._id === it.suiteRunId);
          return [
            it._id,
            {
              model: run?.effectiveModelId || modelName(it),
              client:
                (run ? runHostLabel(run, hostNamesById) : null) ||
                "Unknown client",
            },
          ];
        }),
      ),
    [iterations, suiteRuns, hostNamesById],
  );
  const models = [
    ...new Set(
      [...runMetadata.values()]
        .map((item) => item.model)
        .concat(pendingRun ? [pendingRun.model] : []),
    ),
  ].sort();
  const clients = [
    ...new Set(
      [...runMetadata.values()]
        .map((item) => item.client)
        .concat(pendingRun ? [pendingRun.client ?? "Unknown client"] : []),
    ),
  ].sort();
  const filtered = useMemo(
    () =>
      iterations
        .filter((it) => {
          const metadata = runMetadata.get(it._id)!;
          return (
            (model === ALL_EVAL_FILTER_VALUES || metadata.model === model) &&
            (client === ALL_EVAL_FILTER_VALUES || metadata.client === client)
          );
        })
        .sort((a, b) => b.createdAt - a.createdAt),
    [iterations, model, client, runMetadata],
  );
  const showPendingRun = Boolean(
    pendingRun &&
    (model === ALL_EVAL_FILTER_VALUES || model === pendingRun.model) &&
    (client === ALL_EVAL_FILTER_VALUES ||
      client === (pendingRun.client ?? "Unknown client")),
  );
  const completed = filtered.filter((it) =>
    ["passed", "failed", "timed_out"].includes(computeIterationResult(it)),
  );
  const passed = completed.filter(
    (it) => computeIterationResult(it) === "passed",
  ).length;
  const durations = completed
    .map(duration)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const median = durations.length
    ? (durations[Math.floor((durations.length - 1) / 2)] +
        durations[Math.floor(durations.length / 2)]) /
      2
    : null;
  const calls = completed.length
    ? (
        completed.reduce(
          (sum, it) => sum + (it.actualToolCalls?.length ?? 0),
          0,
        ) / completed.length
      ).toFixed(1)
    : "—";
  const selected = iterations.find((it) => it._id === selectedIterationId);
  const result = selected ? computeIterationResult(selected) : null;
  const verdict =
    liveVerdict ??
    (result === "passed"
      ? "Passed"
      : result === "failed"
        ? "Failed"
        : result === "timed_out"
          ? "Timeout"
          : result === "cancelled"
            ? "Stopped"
            : live || result === "pending"
              ? "Running"
              : "No verdict");
  // Number batches, not their individual model/iteration rows.
  const orderedRunIds = [
    ...new Set(
      [...iterations]
        .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))
        .map((it) => it.suiteRunId ?? it._id),
    ),
  ];
  const runLabel = (iteration?: EvalIteration) => {
    const run = suiteRuns.find((item) => item._id === iteration?.suiteRunId);
    const index = iteration
      ? orderedRunIds.indexOf(iteration.suiteRunId ?? iteration._id)
      : -1;
    const number =
      run?.runNumber ??
      iteration?.iterationNumber ??
      (index >= 0 ? index + 1 : orderedRunIds.length + 1);
    const titles = [
      ...new Set(run?.configSnapshot?.tests.map((test) => test.title) ?? []),
    ];
    const title =
      titles.length === 1
        ? titles[0]
        : iteration?.suiteRunId
          ? suiteName || caseTitle
          : caseTitle;
    return `#${number} ${title}`;
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      aria-label="Case runs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Runs
        </h3>
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-1.5">
          <EvalListFilter
            label="Client"
            value={client}
            options={clients}
            onChange={setClient}
            className={cn(
              "min-w-0 max-w-36",
              client !== ALL_EVAL_FILTER_VALUES &&
                "border-primary/40 ring-1 ring-primary/15",
            )}
          />
          <EvalListFilter
            label="Model"
            value={model}
            options={models}
            onChange={setModel}
            formatOption={compactModelIdTail}
            className={cn(
              "min-w-0 max-w-36",
              model !== ALL_EVAL_FILTER_VALUES &&
                "border-primary/40 ring-1 ring-primary/15",
            )}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-popover text-popover-foreground">
        {[
          {
            label: "Pass rate",
            value: completed.length
              ? `${Math.round((passed / completed.length) * 100)}%`
              : "—",
            detail: `${passed}/${completed.length}`,
          },
          {
            label: "Latency p50",
            value: seconds(median),
            detail: durations.length
              ? `p95 ${seconds(
                  durations[Math.ceil(durations.length * 0.95) - 1],
                )}`
              : "",
          },
          { label: "Tool calls", value: calls, detail: "per run" },
        ].map((metric) => (
          <div key={metric.label} className="min-w-0 px-3 py-3">
            <p className="text-[9px] uppercase tracking-widest text-muted-foreground">
              {metric.label}
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
              <strong className="text-lg tabular-nums">{metric.value}</strong>
              <span className="text-[10px] text-muted-foreground">
                {metric.detail}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="min-h-48 flex-1 rounded-lg border border-border bg-popover text-popover-foreground">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,.8fr)_3.5rem_3rem] gap-2 border-b border-border bg-muted/20 px-3 py-2 text-[9px] uppercase tracking-widest text-muted-foreground">
          <span>Run</span>
          <span>Client / Model</span>
          <span>Result</span>
          <span className="text-right">Time</span>
        </div>
        {(showPendingRun ? [null, ...filtered] : filtered).map((it) => {
          const result = it ? computeIterationResult(it) : "pending";
          const { client, model: recordedModel } = it
            ? runMetadata.get(it._id)!
            : {
                client: pendingRun?.client ?? "Unknown client",
                model: pendingRun!.model,
              };
          const open =
            drawerOpen &&
            (it ? selectedIterationId === it._id : !selectedIterationId);
          return (
            <div
              key={it?._id ?? "pending-run"}
              className="border-b border-border/60 last:border-b-0"
            >
              <button
                type="button"
                data-testid="case-run-row"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                  if (it) onSelect(it);
                  else onSelectLive?.();
                  setDrawerOpen(true);
                }}
                className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,.8fr)_3.5rem_3rem] items-center gap-2 px-3 py-2.5 text-left text-[11px] hover:bg-muted/30"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      result === "passed"
                        ? "bg-success"
                        : result === "failed" || result === "timed_out"
                          ? "bg-destructive"
                          : "bg-warning",
                    )}
                  />
                  <span
                    className="truncate font-medium"
                    title={runLabel(it ?? undefined)}
                  >
                    {runLabel(it ?? undefined)}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {it ? age(it.createdAt) : "just now"}
                  </span>
                </span>
                <span
                  className="min-w-0"
                  title={`${client ?? "Unknown client"} · ${recordedModel}`}
                >
                  <span className="block truncate">
                    {client ?? "Unknown client"}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {compactModelIdTail(recordedModel)}
                  </span>
                </span>
                <span
                  className={cn(
                    "truncate",
                    result === "passed"
                      ? "text-success"
                      : result === "failed" || result === "timed_out"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {result === "passed"
                    ? "Passed"
                    : result === "failed"
                      ? "Failed"
                      : result === "timed_out"
                        ? "Timeout"
                        : result === "cancelled"
                          ? "Stopped"
                          : "Running"}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {seconds(it ? duration(it) : null)}
                </span>
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && !showPendingRun ? (
          <p className="p-4 text-xs text-muted-foreground">
            {model !== ALL_EVAL_FILTER_VALUES ||
            client !== ALL_EVAL_FILTER_VALUES
              ? "No runs match these filters."
              : "Run this case to see its results here."}
          </p>
        ) : null}
      </div>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 sm:w-[min(960px,85vw)] sm:max-w-none"
        >
          <SheetHeader className="shrink-0 border-b border-border pr-12">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="case-run-status"
                className={cn(
                  "inline-flex shrink-0 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  verdict === "Passed"
                    ? "bg-success/15 text-success"
                    : verdict === "Failed" || verdict === "Timeout"
                      ? "bg-destructive/15 text-destructive"
                      : verdict === "Running"
                        ? "bg-warning/30 text-foreground"
                        : "bg-muted text-muted-foreground",
                )}
              >
                {verdict}
              </span>
              <SheetTitle>{runLabel(selected)}</SheetTitle>
            </div>
            <SheetDescription>
              {selected
                ? `Run ${formatRunId(selected.suiteRunId ?? selected._id)} · ${modelName(
                    selected,
                  )} · ${age(selected.createdAt)}`
                : "Conversation, assertions, tool calls, trace, and replay."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
