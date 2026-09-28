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
  formatRelativeTime,
  iterationLatencyP50,
  iterationLatencyP95,
  runHostLabel,
} from "@/components/evals/helpers";
import { formatRunCaseLatencyMs } from "@/components/evals/run-case-groups";
import { compactModelIdTail } from "@/lib/environment-label";
import { cn } from "@mcpjam/design-system/cn";
import { computeIterationResult } from "@/components/evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";

const modelName = (it: EvalIteration) =>
  it.testCaseSnapshot?.model || "Unknown model";
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
              model: run?.effectiveModelId || modelName(it),
              client:
                (run ? runHostLabel(run, hostNamesById) : null) ||
                "Suite default",
            },
          ];
        }),
      ),
    [iterations, suiteRuns, hostNamesById],
  );
  const latestLaunchIterations = useMemo(() => {
    const represented = suiteRuns.filter((run) =>
      iterations.some((iteration) => iteration.suiteRunId === run._id),
    );
    const latest = [...represented].sort(
      (a, b) =>
        (b.runNumber ?? 0) - (a.runNumber ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    )[0];
    if (!latest?.runGroupId) return iterations;
    const launchRunIds = new Set(
      suiteRuns
        .filter((run) => run.runGroupId === latest.runGroupId)
        .map((run) => run._id),
    );
    return iterations.filter(
      (iteration) =>
        !iteration.suiteRunId || launchRunIds.has(iteration.suiteRunId),
    );
  }, [iterations, suiteRuns]);
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
    for (const iteration of latestLaunchIterations) {
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
  }, [latestLaunchIterations, pendingRun, runMetadata]);
  const pendingKey = pendingRun
    ? `${pendingRun.client ?? "Suite default"}\u0000${pendingRun.model}`
    : null;
  // Until the reader picks a target, default to the one the LIVE run is on.
  // Falling straight through to `targets[0]` left a run launched against a
  // client/model the case has no history for invisible — its target is
  // appended last, so `showPendingRun` below was false and the row the user
  // just triggered never appeared.
  const selectedTarget =
    targets.find((target) => target.key === targetKey) ??
    (pendingKey
      ? targets.find((target) => target.key === pendingKey)
      : undefined) ??
    targets[0];
  const selectedTargetKey = selectedTarget?.key ?? null;
  const filtered = useMemo(
    () =>
      [...(selectedTarget?.iterations ?? [])].sort(
        (a, b) =>
          (a.iterationNumber ?? 0) - (b.iterationNumber ?? 0) ||
          a.createdAt - b.createdAt,
      ),
    [selectedTarget],
  );
  const showPendingRun = Boolean(
    pendingRun && pendingKey === selectedTargetKey,
  );
  const completed = filtered.filter((it) =>
    ["passed", "failed", "timed_out"].includes(computeIterationResult(it)),
  );
  const passed = completed.filter(
    (it) => computeIterationResult(it) === "passed",
  ).length;
  const hasFailures = completed.some((it) =>
    ["failed", "timed_out"].includes(computeIterationResult(it)),
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
          Test case averages
        </h3>
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-1.5">
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
              {target.client} · {compactModelIdTail(target.model)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,5rem),1fr))] gap-x-2 gap-y-4 rounded-xl border border-border bg-background px-4 py-4 text-foreground"
        data-testid="case-run-averages">
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
        <div className="min-w-[620px]">
          <div className="grid grid-cols-[minmax(110px,.8fr)_minmax(150px,1fr)_80px_80px_80px_52px] gap-2 border-b border-border bg-muted px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Iteration</span>
            <span>Client / Model</span>
            <span>Result</span>
            <span>Latency</span>
            <span>Tokens</span>
            <span>Calls</span>
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
                  className="grid w-full grid-cols-[minmax(110px,.8fr)_minmax(150px,1fr)_80px_80px_80px_52px] items-center gap-2 px-3 py-2.5 text-left text-xs hover:bg-muted/30"
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
                    <span className="truncate font-medium">
                      #
                      {it?.iterationNumber ??
                        (it ? filtered.indexOf(it) + 1 : filtered.length + 1)}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {it ? formatRelativeTime(it.createdAt) : "just now"}
                    </span>
                  </span>
                  <span
                    className="min-w-0"
                    title={`${client ?? "Suite default"} · ${recordedModel}`}
                  >
                    <span className="block truncate">
                      {client ?? "Suite default"}
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
                  <span className="tabular-nums text-muted-foreground">
                    {/* Same reading the P50/P95 cards above are built from,
                        and the same one the run matrix shows per iteration —
                        `duration()` reported a latency for iterations the
                        cards excluded, so a row and the header disagreed. */}
                    {it ? formatRunCaseLatencyMs(iterationLatencyP95([it])) : "—"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {it && typeof it.tokensUsed === "number"
                      ? compactMetric(it.tokensUsed)
                      : "—"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {it ? (it.actualToolCalls?.length ?? "—") : "—"}
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
