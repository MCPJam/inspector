import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import {
  average,
  compactMetric,
  formatRunId,
  formatTime,
  iterationLatencyP50,
  iterationLatencyP95,
  runHostLabel,
} from "@/components/evals/helpers";
import { formatRunCaseLatencyMs } from "@/components/evals/run-case-groups";
import {
  runIterationTargetKey,
  targetKeyLabel,
  targetKeySuffix,
} from "@/lib/eval-target-key";
import { cn } from "@mcpjam/design-system/cn";
import {
  computeIterationResult,
  computeMeasuredIterationResult,
} from "@/components/evals/pass-criteria";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "@/components/evals/types";

const UNKNOWN_MODEL = "Unknown model";
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
  suiteRuns?: (EvalSuiteRun | EvalSuiteRunListItem)[];
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
  const [targetKey, setTargetKey] = useState<string | null>(null);
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
              // The TARGET (`targetKey`; the bare model id when default), so
              // Sonnet at Low and at High are two chips.
              model: runIterationTargetKey(run, it) || UNKNOWN_MODEL,
              client:
                (run ? runHostLabel(run, hostNamesById) : null) ||
                "Suite default",
            },
          ];
        }),
      ),
    [iterations, suiteRuns, hostNamesById],
  );
  const targets = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        client: string;
        model: string;
        iterations: EvalIteration[];
      }
    >();
    for (const iteration of iterations) {
      const metadata = runMetadata.get(iteration._id)!;
      const key = `${metadata.client}\u0000${metadata.model}`;
      const target = grouped.get(key) ?? {
        key,
        client: metadata.client,
        model: metadata.model,
        iterations: [],
      };
      target.iterations.push(iteration);
      grouped.set(key, target);
    }
    if (pendingRun) {
      const client = pendingRun.client ?? "Suite default";
      const key = `${client}\u0000${pendingRun.model}`;
      if (!grouped.has(key))
        grouped.set(key, {
          key,
          client,
          model: pendingRun.model,
          iterations: [],
        });
    }
    return [...grouped.values()];
  }, [iterations, pendingRun, runMetadata]);
  // Labels show only what differs: a lone target reads as its model.
  const targetKeysInView = useMemo(
    () => [
      ...new Set([
        ...[...runMetadata.values()].map((metadata) => metadata.model),
        ...(pendingRun ? [pendingRun.model] : []),
      ]),
    ],
    [runMetadata, pendingRun],
  );
  const modelLabel = (key: string) =>
    key === UNKNOWN_MODEL ? key : targetKeyLabel(key, targetKeysInView);
  const modelTitle = (key: string) =>
    key === UNKNOWN_MODEL
      ? key
      : targetKeyLabel(key, targetKeysInView, (modelId) => modelId);
  const pendingKey = pendingRun
    ? `${pendingRun.client ?? "Suite default"}\u0000${pendingRun.model}`
    : null;
  // A client/model filter applies only after the user picks a chip.
  const selectedTarget = targets.find((target) => target.key === targetKey);
  const selectedTargetKey = selectedTarget?.key ?? null;
  const filtered = useMemo(
    () =>
      [...(selectedTarget?.iterations ?? iterations)].sort(
        (a, b) =>
          (a.iterationNumber ?? 0) - (b.iterationNumber ?? 0) ||
          a.createdAt - b.createdAt,
      ),
    [selectedTarget, iterations],
  );
  const showPendingRun = Boolean(
    pendingRun && (!selectedTargetKey || pendingKey === selectedTargetKey),
  );
  // Measured results: an infra row is in neither the pass count nor the tone.
  const completed = filtered.filter((it) =>
    ["passed", "failed", "timed_out"].includes(
      computeMeasuredIterationResult(it),
    ),
  );
  const passed = completed.filter(
    (it) => computeMeasuredIterationResult(it) === "passed",
  ).length;
  const hasFailures = completed.some((it) =>
    ["failed", "timed_out"].includes(computeMeasuredIterationResult(it)),
  );
  const tokenAverage = average(
    completed.flatMap((it) =>
      typeof it.tokensUsed === "number" ? [it.tokensUsed] : [],
    ),
  );
  // An iteration that recorded NO tool-call list did not make zero calls — it
  // measured nothing. Excluding it matches the same average in the run matrix;
  // counting it as 0 dragged this one down against the other.
  const callAverage = average(
    completed.flatMap((it) =>
      it.actualToolCalls ? [it.actualToolCalls.length] : [],
    ),
  );
  const selected = iterations.find((it) => it._id === selectedIterationId);
  const selectedKey = selected ? runMetadata.get(selected._id)?.model : null;
  const selectedSuffix =
    selectedKey && selectedKey !== UNKNOWN_MODEL
      ? targetKeySuffix(selectedKey, targetKeysInView)
      : "";
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
        .map(
          (it) =>
            suiteRuns.find((run) => run._id === it.suiteRunId)?.runGroupId ??
            it.suiteRunId ??
            it._id,
        ),
    ),
  ];
  const runNumber = (iteration?: EvalIteration) => {
    const run = suiteRuns.find((item) => item._id === iteration?.suiteRunId);
    const siblings = run?.runGroupId
      ? suiteRuns.filter((item) => item.runGroupId === run.runGroupId)
      : run
        ? [run]
        : [];
    const numbers = siblings.flatMap((item) =>
      typeof item.runNumber === "number" ? [item.runNumber] : [],
    );
    const key = run?.runGroupId ?? iteration?.suiteRunId ?? iteration?._id;
    const index = key ? orderedRunIds.indexOf(key) : -1;
    return numbers.length
      ? Math.min(...numbers)
      : index >= 0
        ? index + 1
        : orderedRunIds.length + 1;
  };
  const runLabel = (iteration?: EvalIteration) => {
    const run = suiteRuns.find((item) => item._id === iteration?.suiteRunId);
    const number = runNumber(iteration);
    const titles = [
      ...new Set(
        run && "tests" in run.configSnapshot
          ? run.configSnapshot.tests.map((test) => test.title)
          : [],
      ),
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
          Test case averages
        </h3>
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-1.5">
          {targets.length > 1 && (
            <button
              type="button"
              aria-pressed={!selectedTargetKey}
              onClick={() => setTargetKey(null)}
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs transition-colors",
                !selectedTargetKey
                  ? "border-border bg-muted font-medium text-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              All clients
            </button>
          )}
          {targets.map((target) => (
            <button
              key={target.key}
              type="button"
              aria-pressed={target.key === selectedTargetKey}
              onClick={() => setTargetKey(target.key)}
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs transition-colors",
                target.key === selectedTargetKey
                  ? "border-border bg-muted font-medium text-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {target.client} · {modelLabel(target.model)}
            </button>
          ))}
        </div>
      </div>
      <div
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,5rem),1fr))] gap-x-2 gap-y-4 rounded-xl border border-border bg-background px-4 py-4 text-foreground"
        data-testid="case-run-averages"
      >
        {[
          {
            label: "Passed",
            value: `${passed}/${filtered.length + (showPendingRun ? 1 : 0)}`,
            tone: hasFailures
              ? "text-destructive"
              : showPendingRun
                ? "text-warning"
                : completed.length > 0 && passed === completed.length
                  ? "text-success"
                  : "text-muted-foreground",
          },
          {
            label: "P50",
            value: formatRunCaseLatencyMs(iterationLatencyP50(completed)),
          },
          {
            label: "P95",
            value: formatRunCaseLatencyMs(iterationLatencyP95(completed)),
          },
          {
            label: "Tokens",
            value: tokenAverage === null ? "—" : compactMetric(tokenAverage),
          },
          {
            label: "Calls",
            value: callAverage === null ? "—" : compactMetric(callAverage),
          },
        ].map((metric) => (
          <div key={metric.label} className="min-w-0 px-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {metric.label}
            </p>
            <strong
              className={cn(
                "mt-1 block text-[28px] leading-8 tracking-tight tabular-nums",
                metric.tone,
              )}
            >
              {metric.value}
            </strong>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-background text-foreground">
        <div className="min-w-[850px]">
          <div className="grid grid-cols-[52px_64px_minmax(150px,1fr)_80px_80px_80px_52px_minmax(160px,1fr)] gap-2 border-b border-border bg-muted px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Run</span>
            <span>Iteration</span>
            <span>Client / Model</span>
            <span>Result</span>
            <span>Latency</span>
            <span>Tokens</span>
            <span>Calls</span>
            <span>Date</span>
          </div>
          {(showPendingRun ? [null, ...filtered] : filtered).map((it) => {
            const result = it ? computeIterationResult(it) : "pending";
            const { client, model: recordedModel } = it
              ? runMetadata.get(it._id)!
              : {
                  client: pendingRun?.client ?? "Suite default",
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
                  className="grid w-full grid-cols-[52px_64px_minmax(150px,1fr)_80px_80px_80px_52px_minmax(160px,1fr)] items-center gap-2 px-3 py-2.5 text-left text-xs hover:bg-muted/30"
                >
                  <span
                    className="truncate font-medium"
                    data-testid="case-run-number"
                  >
                    {it ? `#${runNumber(it)}` : "—"}
                  </span>
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
                    <span className="truncate font-medium">
                      #
                      {it?.iterationNumber ??
                        (it ? filtered.indexOf(it) + 1 : filtered.length + 1)}
                    </span>
                  </span>
                  <span
                    className="min-w-0"
                    title={`${client ?? "Suite default"} · ${modelTitle(
                      recordedModel,
                    )}`}
                  >
                    <span className="block truncate">
                      {client ?? "Suite default"}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {modelLabel(recordedModel)}
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
                  <span className="tabular-nums text-muted-foreground">
                    {/* Same reading the P50/P95 cards above are built from,
                        and the same one the run matrix shows per iteration —
                        `duration()` reported a latency for iterations the
                        cards excluded, so a row and the header disagreed. */}
                    {it
                      ? formatRunCaseLatencyMs(iterationLatencyP95([it]))
                      : "—"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {it && typeof it.tokensUsed === "number"
                      ? compactMetric(it.tokensUsed)
                      : "—"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {it ? (it.actualToolCalls?.length ?? "—") : "—"}
                  </span>
                  <span
                    className="truncate text-muted-foreground"
                    data-testid="case-run-date"
                    title={it ? formatTime(it.createdAt) : undefined}
                  >
                    {it ? (
                      <time dateTime={new Date(it.createdAt).toISOString()}>
                        {formatTime(it.createdAt)}
                      </time>
                    ) : (
                      "just now"
                    )}
                  </span>
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && !showPendingRun ? (
            <p className="p-4 text-xs text-muted-foreground">
              Run this case to see its results here.
            </p>
          ) : null}
        </div>
      </div>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 sm:w-[min(960px,85vw)] sm:max-w-none"
        >
          <SheetHeader className="shrink-0 border-b border-border pr-12">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>{runLabel(selected)}</SheetTitle>
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
            </div>
            <SheetDescription>
              {selected
                ? `Run ${formatRunId(selected.suiteRunId ?? selected._id)} · ${
                    selected.testCaseSnapshot?.model || UNKNOWN_MODEL
                  }${selectedSuffix} · ${age(selected.createdAt)}`
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
