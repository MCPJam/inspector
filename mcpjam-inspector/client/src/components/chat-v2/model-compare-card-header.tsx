import { Loader2 } from "lucide-react";
import type { ModelDefinition } from "@/shared/types";
import {
  ChatTraceViewModeHeaderBar,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import { cn } from "@/lib/utils";

export type MultiModelCardStatus = "idle" | "ready" | "running" | "error";

export interface MultiModelCardSummary {
  modelId: string;
  durationMs: number | null;
  tokens: number;
  toolCount: number;
  status: MultiModelCardStatus;
  hasMessages: boolean;
}

function formatCardDuration(durationMs: number | null): string {
  if (durationMs == null || durationMs <= 0) {
    return "—";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${Math.round(durationMs / 100) / 10}s`;
}

export function ModelCompareCardHeader({
  model,
  summary,
  allSummaries,
  mode,
  onModeChange,
  showTraceTabs,
  showComparisonChrome = true,
  /** When true (default), hides the status dot and Tools row — latency/tokens only. Set false for full compare metrics. */
  compactCompareHeader = true,
  className,
}: {
  model: ModelDefinition;
  summary: MultiModelCardSummary | null;
  allSummaries: MultiModelCardSummary[];
  mode: "chat" | "timeline" | "raw";
  onModeChange: (mode: "chat" | "timeline" | "raw") => void;
  showTraceTabs: boolean;
  /** When false, hides model title and Latency/Tokens/Tools rows (single-model-in-compare mode). */
  showComparisonChrome?: boolean;
  compactCompareHeader?: boolean;
  className?: string;
}) {
  if (!showComparisonChrome && !showTraceTabs) {
    return null;
  }

  const isErroredSummary = summary?.status === "error";
  const comparableSummaries = allSummaries.filter(
    (item) =>
      item.status !== "error" && item.durationMs != null && item.durationMs > 0,
  );
  const durationValues = comparableSummaries
    .map((item) => item.durationMs ?? 0)
    .filter((value) => value > 0);
  const tokenValues = comparableSummaries
    .map((item) => item.tokens)
    .filter((value) => value > 0);
  const toolValues = comparableSummaries
    .map((item) => item.toolCount)
    .filter((value) => value > 0);

  const maxDuration =
    durationValues.length > 0 ? Math.max(...durationValues) : 0;
  const minDuration =
    durationValues.length > 0 ? Math.min(...durationValues) : 0;
  const maxTokens = tokenValues.length > 0 ? Math.max(...tokenValues) : 0;
  const minTokens = tokenValues.length > 0 ? Math.min(...tokenValues) : 0;
  const minToolCount = toolValues.length > 0 ? Math.min(...toolValues) : 0;
  const hasComparison = comparableSummaries.length > 1;
  const hasRunningSummary = allSummaries.some(
    (item) => item.status === "running",
  );
  const canHighlightWinner = hasComparison && !hasRunningSummary;

  const currentDuration = summary?.durationMs ?? 0;
  const currentTokens = summary?.tokens ?? 0;
  const currentToolCount = summary?.toolCount ?? 0;

  const isFastest =
    canHighlightWinner &&
    !isErroredSummary &&
    currentDuration > 0 &&
    currentDuration === minDuration;
  const isFewestTokens =
    canHighlightWinner &&
    !isErroredSummary &&
    currentTokens > 0 &&
    currentTokens === minTokens;
  const isFewestTools =
    canHighlightWinner &&
    !isErroredSummary &&
    currentToolCount > 0 &&
    currentToolCount === minToolCount;
  const isRunningSummary = summary?.status === "running";

  const durationBarPct =
    maxDuration > 0
      ? Math.min(100, Math.max(4, (currentDuration / maxDuration) * 100))
      : 0;
  const tokensBarPct =
    maxTokens > 0
      ? Math.min(100, Math.max(4, (currentTokens / maxTokens) * 100))
      : 0;

  const statusIndicatorClass =
    summary?.status === "running"
      ? "size-3 bg-amber-500/45 dark:bg-amber-400/40 animate-pulse motion-reduce:animate-none"
      : summary?.status === "error"
        ? "size-3 bg-rose-500/45 dark:bg-rose-400/40"
        : summary?.status === "ready"
          ? "size-3 bg-primary/22 dark:bg-primary/20"
          : "size-3 bg-muted";
  const statusLabel =
    summary?.status === "running"
      ? "Running"
      : summary?.status === "error"
        ? "Failed"
        : summary?.status === "ready"
          ? "Ready"
          : "Idle";
  const toolCallLabel =
    currentToolCount === 1 ? "1 tool call" : `${currentToolCount} tool calls`;

  return (
    <>
      {showComparisonChrome ? (
        <div
          className={cn(
            "shrink-0 border-b border-border/60 px-3 py-2",
            showTraceTabs && "border-b-0",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">
                {model.name}
              </div>
            </div>
            {isRunningSummary ? (
              <span
                className="inline-flex shrink-0 text-muted-foreground"
                aria-label={statusLabel}
                title={statusLabel}
              >
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              </span>
            ) : !compactCompareHeader ? (
              <span
                role="img"
                className={cn(
                  "inline-flex shrink-0 rounded-full",
                  statusIndicatorClass,
                )}
                aria-label={statusLabel}
                title={statusLabel}
              />
            ) : null}
          </div>

          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-[52px] shrink-0 text-[10px] text-muted-foreground">
                Latency
              </span>
              <div className="relative flex min-w-0 flex-1 items-center">
                <div className="h-[14px] w-full overflow-hidden rounded-sm bg-muted/40">
                  {currentDuration > 0 ? (
                    <div
                      className={cn(
                        "h-full rounded-sm transition-all duration-300",
                        isFastest
                          ? "bg-emerald-500/25 dark:bg-emerald-400/20"
                          : "bg-primary/10",
                      )}
                      style={{
                        width: `${hasComparison ? durationBarPct : 100}%`,
                      }}
                    />
                  ) : null}
                </div>
                <span
                  className={cn(
                    "absolute inset-0 flex items-center px-1.5 text-[10px] font-medium tabular-nums",
                    isFastest
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-foreground",
                  )}
                >
                  {formatCardDuration(summary?.durationMs ?? null)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="w-[52px] shrink-0 text-[10px] text-muted-foreground">
                Tokens
              </span>
              <div className="relative flex min-w-0 flex-1 items-center">
                <div className="h-[14px] w-full overflow-hidden rounded-sm bg-muted/40">
                  {currentTokens > 0 ? (
                    <div
                      className={cn(
                        "h-full rounded-sm transition-all duration-300",
                        isFewestTokens
                          ? "bg-emerald-500/25 dark:bg-emerald-400/20"
                          : "bg-primary/10",
                      )}
                      style={{
                        width: `${hasComparison ? tokensBarPct : 100}%`,
                      }}
                    />
                  ) : null}
                </div>
                <span
                  className={cn(
                    "absolute inset-0 flex items-center px-1.5 text-[10px] font-medium tabular-nums",
                    isFewestTokens
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-foreground",
                  )}
                >
                  {currentTokens > 0 ? currentTokens.toLocaleString() : "—"}
                </span>
              </div>
            </div>

            {!compactCompareHeader ? (
              <div className="flex items-center gap-2">
                <span className="w-[52px] shrink-0 text-[10px] text-muted-foreground">
                  Tools
                </span>
                <span
                  className={cn(
                    "px-1.5 text-[10px] font-medium tabular-nums",
                    isFewestTools
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-foreground",
                  )}
                >
                  {summary?.hasMessages ? toolCallLabel : "—"}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showTraceTabs ? (
        <ChatTraceViewModeHeaderBar
          mode={mode as TraceViewMode}
          activeVariant="sidebar"
          onModeChange={(nextMode) => {
            if (nextMode === "tools") {
              return;
            }
            onModeChange(nextMode as typeof mode);
          }}
          className={!showComparisonChrome ? className : undefined}
        />
      ) : null}
    </>
  );
}
