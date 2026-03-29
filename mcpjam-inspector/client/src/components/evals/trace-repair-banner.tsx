import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ClipboardCopy, Footprints, Loader2, X } from "lucide-react";
import { toast } from "sonner";

const OUTCOME_DISMISS_PREFIX = "mcpjam:traceRepairOutcomeDismissed:";

function isOutcomeDismissed(jobId: string): boolean {
  if (typeof sessionStorage === "undefined") {
    return false;
  }
  return sessionStorage.getItem(`${OUTCOME_DISMISS_PREFIX}${jobId}`) === "1";
}

function setOutcomeDismissedStorage(jobId: string) {
  sessionStorage.setItem(`${OUTCOME_DISMISS_PREFIX}${jobId}`, "1");
}

export type TraceRepairJobViewSnapshot = {
  jobId: string;
  status: string;
  phase: string;
  scope: "suite" | "case";
  currentCaseKey?: string | null;
  activeCaseKeys?: string[];
  attemptLimit?: number;
  provisionalAppliedCount?: number;
  durableFixCount?: number;
  regressedCount?: number;
  serverLikelyCount?: number;
  exhaustedCount?: number;
  promisingCount?: number;
  accuracyBefore?: number | null;
  accuracyAfter?: number | null;
};

export type TraceRepairOutcomeSnapshot = TraceRepairJobViewSnapshot & {
  stopReason?: string;
  lastError?: string;
  completedAt?: number;
  updatedAt?: number;
};

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing":
      return "Preparing";
    case "repairing":
      return "Repairing";
    case "replaying":
      return "Replaying suite";
    case "finalizing":
      return "Finalizing";
    default:
      return phase;
  }
}

function formatPassRate(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) {
    return "—";
  }
  const pct = v <= 1 ? Math.round(v * 100) : Math.round(v);
  return `${pct}%`;
}

export interface TraceRepairBannerProps {
  scope: "suite" | "case";
  activeView: TraceRepairJobViewSnapshot | null;
  caseTitleByKey: Record<string, string>;
  onStop: () => void | Promise<void>;
  latestOutcome?: TraceRepairOutcomeSnapshot | null;
  showTerminalOutcome?: boolean;
  /**
   * When true, parent fetches `traceRepair:getTraceRepairJobDebugJson` (job id required).
   * `traceRepairDebugJson` is undefined while loading; omit or false to hide Copy JSON.
   */
  traceRepairCopyDebug?: boolean;
  traceRepairDebugJson?: unknown;
  className?: string;
}

export function TraceRepairBanner({
  scope,
  activeView,
  caseTitleByKey,
  onStop,
  latestOutcome,
  showTerminalOutcome = true,
  traceRepairCopyDebug = false,
  traceRepairDebugJson,
  className,
}: TraceRepairBannerProps) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [debugCopied, setDebugCopied] = useState(false);

  const copyDebugLoading =
    traceRepairCopyDebug &&
    (traceRepairDebugJson === undefined || traceRepairDebugJson === null);

  const showCopyDebug = traceRepairCopyDebug;

  const copyDebugJson = async () => {
    if (traceRepairDebugJson === undefined || traceRepairDebugJson === null) {
      return;
    }
    const text = JSON.stringify(traceRepairDebugJson, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setDebugCopied(true);
      window.setTimeout(() => setDebugCopied(false), 2000);
      toast.success("Copied debug JSON");
    } catch {
      setDebugCopied(false);
      toast.error("Could not copy to clipboard");
    }
  };

  const active = activeView != null;
  const dismissed =
    latestOutcome &&
    (dismissedId === latestOutcome.jobId ||
      isOutcomeDismissed(latestOutcome.jobId));

  const currentCaseTitle = useMemo(() => {
    if (!activeView?.currentCaseKey) {
      return null;
    }
    return (
      caseTitleByKey[activeView.currentCaseKey] ?? activeView.currentCaseKey
    );
  }, [activeView?.currentCaseKey, caseTitleByKey]);

  const activeStatsLine = useMemo(() => {
    if (!activeView) {
      return null;
    }
    const p = activeView.provisionalAppliedCount ?? 0;
    const sl = activeView.serverLikelyCount ?? 0;
    const ex = activeView.exhaustedCount ?? 0;
    const pr = activeView.promisingCount ?? 0;
    return `Provisional: ${p} · Likely server: ${sl} · Exhausted: ${ex} · In flight: ${pr}`;
  }, [activeView]);

  const terminalLines = useMemo(() => {
    if (!latestOutcome || active || !showTerminalOutcome || dismissed) {
      return [] as string[];
    }
    const o = latestOutcome;
    const lines: string[] = [];
    const prov = o.provisionalAppliedCount ?? 0;
    const dur = o.durableFixCount ?? 0;
    const reg = o.regressedCount ?? 0;
    const sl = o.serverLikelyCount ?? 0;
    const reason = o.stopReason ?? "";

    if (scope === "suite") {
      lines.push(
        `Provisional applied: ${prov} · Durable fixes: ${dur} · Regressed: ${reg} · Likely server: ${sl}`,
      );
      lines.push(
        `Accuracy ${formatPassRate(o.accuracyBefore)} → ${formatPassRate(o.accuracyAfter)}`,
      );
      if (reason === "completed_replayed") {
        lines.push("Suite replay finished; durable fixes stayed green in replay.");
      } else if (reason === "completed_server_likely") {
        lines.push("No promotions; repeated failures matched the same signature.");
      } else if (reason === "stopped_nothing_to_repair") {
        lines.push(
          "No failed cases on this run for trace repair; nothing was changed.",
        );
      } else if (reason === "stopped_generation_error") {
        lines.push(
          "Trace repair generation ran, but no usable repair candidate JSON was produced, so verification and replay never started.",
        );
      } else if (reason === "stopped_no_progress") {
        lines.push(
          "Trace repair ran, but no candidate produced enough verified progress to promote or replay.",
        );
      }
    } else {
      if (reason === "completed_case" || prov > 0) {
        lines.push(
          `Provisional applied: ${prov > 0 ? "yes" : "no"} · Likely server: ${sl > 0 ? "yes" : "no"}`,
        );
        lines.push(
          "Result is provisional: no suite replay was run for single-case trace repair.",
        );
      } else if (reason === "completed_server_likely") {
        lines.push("Likely server issue: three attempts failed with the same signature.");
      } else if (reason === "stopped_nothing_to_repair") {
        lines.push(
          "No failed cases on this run for trace repair; nothing was changed.",
        );
      } else if (reason === "stopped_generation_error") {
        lines.push(
          "Trace repair generation ran, but no usable repair candidate JSON was produced, so verification never started.",
        );
      } else if (reason === "stopped_no_progress") {
        lines.push(
          "Trace repair ran, but no candidate produced enough verified progress to confirm a repair or a likely server fault.",
        );
      }
    }

    if (o.lastError) {
      lines.push(`Error: ${o.lastError}`);
    }
    return lines;
  }, [latestOutcome, active, showTerminalOutcome, dismissed, scope]);

  if (active && activeView) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm",
          className,
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <Footprints className="h-4 w-4 shrink-0 opacity-80" />
            <span>Trace repair</span>
            <span className="text-muted-foreground font-normal">
              {phaseLabel(activeView.phase)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {showCopyDebug ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-muted-foreground"
                disabled={
                  copyDebugLoading ||
                  traceRepairDebugJson === undefined ||
                  traceRepairDebugJson === null
                }
                onClick={() => void copyDebugJson()}
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                {copyDebugLoading
                  ? "Loading…"
                  : debugCopied
                    ? "Copied"
                    : "Copy JSON"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-muted-foreground"
              onClick={() => void onStop()}
            >
              <X className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
        </div>
        {currentCaseTitle ? (
          <p className="text-xs text-muted-foreground">
            Current case: {currentCaseTitle}
          </p>
        ) : null}
        {activeStatsLine ? (
          <p className="text-xs text-muted-foreground">{activeStatsLine}</p>
        ) : null}
      </div>
    );
  }

  if (
    showTerminalOutcome &&
    latestOutcome &&
    !dismissed &&
    terminalLines.length > 0
  ) {
    return (
      <div
        className={cn(
          "relative flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm",
          className,
        )}
      >
        <div className="absolute right-2 top-2 flex max-w-[calc(100%-8rem)] items-center justify-end gap-0.5">
          {showCopyDebug ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-muted-foreground"
              disabled={
                copyDebugLoading ||
                traceRepairDebugJson === undefined ||
                traceRepairDebugJson === null
              }
              onClick={() => void copyDebugJson()}
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only sm:text-xs">
                {copyDebugLoading
                  ? "Loading…"
                  : debugCopied
                    ? "Copied"
                    : "Copy JSON"}
              </span>
            </Button>
          ) : null}
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Dismiss trace repair outcome"
            onClick={() => {
              setDismissedId(latestOutcome.jobId);
              setOutcomeDismissedStorage(latestOutcome.jobId);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 pr-24 font-medium sm:pr-28">
          <Footprints className="h-4 w-4 shrink-0 opacity-80" />
          Trace repair finished
        </div>
        {terminalLines.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    );
  }

  return null;
}
