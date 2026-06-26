/**
 * CaseRunsHistory — the editor right pane's "Runs" tab. Promotes per-case run
 * history from a flat footer table into a scannable surface: the shared metric
 * strip scoped to this case's run batches, then iterations grouped under the
 * Run that produced them (Braintrust/LangSmith style). Clicking an iteration
 * replays it in Preview.
 */
import { useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { HostChip } from "@/components/hosts/host-chip";
import { CaseMetricStrip } from "../case-metric-strip";
import { computeIterationResult } from "../pass-criteria";
import {
  caseRunBatchTrigger,
  groupCaseIterations,
  resolveCaseRunBatchHost,
  type CaseRunBatch,
} from "./group-case-iterations";
import type { EvalIteration, EvalSuiteRun } from "../types";

type Result = ReturnType<typeof computeIterationResult>;

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function durationSecs(it: EvalIteration): number | null {
  const start = it.startedAt ?? it.createdAt;
  const end = it.updatedAt ?? it.createdAt;
  if (!start || !end) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function ResultDot({ result }: { result: Result }) {
  if (result === "pending") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" />;
  }
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        result === "passed" && "bg-emerald-500",
        result === "failed" && "bg-rose-500",
        result === "cancelled" && "bg-warning/60",
      )}
    />
  );
}

function RunBatchGroup({
  batch,
  expanded,
  onToggle,
  onSelectIteration,
  selectedIterationId,
  runsById,
  hostNamesById,
  defaultHostLabel,
  hasHostAttachments,
}: {
  batch: CaseRunBatch;
  expanded: boolean;
  onToggle: () => void;
  onSelectIteration: (it: EvalIteration) => void;
  selectedIterationId: string | null;
  runsById?: Map<string, EvalSuiteRun>;
  hostNamesById?: Map<string, string | null>;
  defaultHostLabel?: string | null;
  hasHostAttachments?: boolean;
}) {
  const batchHost = resolveCaseRunBatchHost(batch, {
    runsById,
    hostNamesById,
    defaultHostLabel,
    hasHostAttachments,
  });
  const total = batch.iterations.length;
  const decided = batch.iterations.filter((i) => {
    const r = computeIterationResult(i);
    return r === "passed" || r === "failed";
  });
  const passed = decided.filter(
    (i) => computeIterationResult(i) === "passed",
  ).length;
  const allPass = decided.length > 0 && passed === decided.length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted/40"
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        {(() => {
          const trigger = caseRunBatchTrigger(batch);
          const meta = {
            quick: {
              label: "Quick",
              title: "Quick run from the case editor",
              className: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
            },
            suite: {
              label: "Suite",
              title: "Ran as part of a suite run",
              className: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
            },
            replay: {
              label: "Replay",
              title: "Re-ran from a previous run",
              className: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
            },
          }[trigger];
          return (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                meta.className,
              )}
              title={meta.title}
            >
              {meta.label}
            </span>
          );
        })()}
        <span className="text-[12px] text-muted-foreground">
          {formatTimeAgo(batch.createdAt)}
        </span>
        {batchHost ? (
          <HostChip
            name={batchHost.hostName}
            hostId={batchHost.hostId}
            className="shrink-0 max-w-[120px] gap-1 border-primary/35 bg-primary/10 px-2 py-0.5 text-[10px] text-primary shadow-none"
          />
        ) : null}
        <span className="flex items-center gap-1">
          {batch.iterations.map((it) => (
            <ResultDot key={it._id} result={computeIterationResult(it)} />
          ))}
        </span>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
            allPass
              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
              : "bg-amber-500/14 text-amber-700 dark:text-amber-400",
          )}
        >
          {passed}/{total}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border">
          <div className="flex items-center gap-3 bg-muted/30 px-3 py-1 pl-10 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="w-12">Iter</span>
            <span className="ml-auto flex items-center gap-5">
              <span className="w-10 text-center">Calls</span>
              <span className="w-14 text-right">Tokens</span>
              <span className="w-10 text-right">Time</span>
            </span>
          </div>
          {batch.iterations.map((it) => {
            const secs = durationSecs(it);
            return (
              <button
                key={it._id}
                type="button"
                onClick={() => onSelectIteration(it)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 pl-10 text-left text-[12px] transition hover:bg-muted/40",
                  selectedIterationId === it._id && "bg-muted/50",
                )}
              >
                <span className="flex w-12 items-center gap-1.5">
                  <ResultDot result={computeIterationResult(it)} />
                  <span className="text-muted-foreground">
                    #{it.iterationNumber}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-5 font-mono tabular-nums text-muted-foreground">
                  <span className="w-10 text-center">
                    {(it.actualToolCalls || []).length}
                  </span>
                  <span className="w-14 text-right">
                    {Number(it.tokensUsed || 0).toLocaleString()}
                  </span>
                  <span className="w-10 text-right">
                    {secs !== null ? `${secs}s` : "—"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function CaseRunsHistory({
  iterations,
  onSelectIteration,
  selectedIterationId = null,
  emptyState = "No iterations yet — run this case to see results here.",
  suiteRuns = [],
  hostNamesById,
  defaultHostLabel = null,
  hasHostAttachments = false,
}: {
  iterations: EvalIteration[];
  onSelectIteration: (it: EvalIteration) => void;
  selectedIterationId?: string | null;
  emptyState?: string;
  /** Parent suite runs — used to resolve `namedHostId` for suite batches. */
  suiteRuns?: EvalSuiteRun[];
  hostNamesById?: Map<string, string | null>;
  /** Shown for attachment-less suites when a run has no `namedHostId`. */
  defaultHostLabel?: string | null;
  hasHostAttachments?: boolean;
}) {
  const batches = useMemo(() => groupCaseIterations(iterations), [iterations]);
  const runsById = useMemo(
    () => new Map(suiteRuns.map((run) => [run._id, run])),
    [suiteRuns],
  );
  // `null` = untouched → default-expand the newest batch only. Once the user
  // toggles, the explicit set takes over.
  const [expandedKeys, setExpandedKeys] = useState<Set<string> | null>(null);
  const defaultExpanded = () =>
    new Set(batches[0] ? [batches[0].key] : []);
  const effectiveExpanded = expandedKeys ?? defaultExpanded();
  const toggle = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev ?? defaultExpanded());
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (iterations.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        {emptyState}
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-4">
      <CaseMetricStrip batches={batches} />
      <div className="space-y-2">
        {batches.map((batch) => (
          <RunBatchGroup
            key={batch.key}
            batch={batch}
            expanded={effectiveExpanded.has(batch.key)}
            onToggle={() => toggle(batch.key)}
            onSelectIteration={onSelectIteration}
            selectedIterationId={selectedIterationId}
            runsById={runsById}
            hostNamesById={hostNamesById}
            defaultHostLabel={defaultHostLabel}
            hasHostAttachments={hasHostAttachments}
          />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        Click a run to replay it in the conversation view.
      </p>
    </div>
  );
}
