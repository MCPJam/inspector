import { type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { ModelDefinition } from "@/shared/types";
import {
  ChatTraceViewModeHeaderBar,
  TraceViewModeTabs,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import { cn } from "@/lib/utils";

export type MultiModelCardStatus =
  | "idle"
  | "ready"
  | "running"
  | "error"
  | "cancelled";

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
  modelLabel: modelLabelProp,
  summary,
  allSummaries,
  mode,
  onModeChange,
  showTraceTabs,
  showComparisonChrome = true,
  /** When true (default), hides the status dot and Tools row — latency/tokens only. Set false for full compare metrics. */
  compactCompareHeader = true,
  result,
  showToolsTab = false,
  tabsInline = false,
  actionsSlot,
  footerNote,
  className,
}: {
  /** Full model definition (used in Chat multi-model). Optional when `modelLabel` is provided. */
  model?: ModelDefinition;
  /** Override for the displayed model name; takes precedence over `model.name`. */
  modelLabel?: string;
  summary: MultiModelCardSummary | null;
  allSummaries: MultiModelCardSummary[];
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  showTraceTabs: boolean;
  /** When false, hides model title and Latency/Tokens/Tools rows (single-model-in-compare mode). */
  showComparisonChrome?: boolean;
  compactCompareHeader?: boolean;
  /** When set, shows a Pass/Fail pill instead of the status dot. */
  result?: "passed" | "failed" | null;
  /** Include a Results tab alongside Trace/Chat/Raw. Only applies when `tabsInline` is true. */
  showToolsTab?: boolean;
  /**
   * When true, tabs are rendered inline inside the metrics block (with `actionsSlot`) rather
   * than as a full-width strip below it. Use this for eval playground cards.
   */
  tabsInline?: boolean;
  /** Extra action buttons placed to the right of the inline tab strip. */
  actionsSlot?: ReactNode;
  /** Short note shown below the metrics block (e.g. mismatch count). */
  footerNote?: ReactNode;
  className?: string;
}) {
  if (!showComparisonChrome && !showTraceTabs) {
    return null;
  }

  const displayName = modelLabelProp ?? model?.name ?? "";

  const isNonComparableSummary =
    summary?.status === "error" || summary?.status === "cancelled";
  const comparableSummaries = allSummaries.filter(
    (item) =>
      item.status !== "error" &&
      item.status !== "cancelled" &&
      item.durationMs != null &&
      item.durationMs > 0,
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
    !isNonComparableSummary &&
    currentDuration > 0 &&
    currentDuration === minDuration;
  const isFewestTokens =
    canHighlightWinner &&
    !isNonComparableSummary &&
    currentTokens > 0 &&
    currentTokens === minTokens;
  const isFewestTools =
    canHighlightWinner &&
    !isNonComparableSummary &&
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
      : summary?.status === "cancelled"
        ? "size-3 bg-amber-500/45 dark:bg-amber-400/40"
        : summary?.status === "error"
          ? "size-3 bg-rose-500/45 dark:bg-rose-400/40"
          : summary?.status === "ready"
            ? "size-3 bg-primary/22 dark:bg-primary/20"
            : "size-3 bg-muted";
  const statusLabel =
    summary?.status === "running"
      ? "Running"
      : summary?.status === "cancelled"
        ? "Stopped"
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
            showTraceTabs && !tabsInline && "border-b-0",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="truncate text-sm font-semibold leading-tight">
                {displayName}
              </div>
              {!compactCompareHeader && result === "passed" ? (
                <span
                  className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
                  aria-label="Passed"
                >
                  Passed
                </span>
              ) : !compactCompareHeader && result === "failed" ? (
                <span
                  className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300"
                  aria-label="Failed"
                >
                  Failed
                </span>
              ) : null}
            </div>
            {!compactCompareHeader && result == null ? (
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
              <span className="flex w-[52px] shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                <span>Latency</span>
                {isRunningSummary ? (
                  <Loader2
                    data-testid="metric-running-spinner"
                    className="h-3 w-3 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : null}
              </span>
              <div className="relative flex min-w-0 flex-1 items-center">
                <div className="h-[14px] w-full overflow-hidden rounded-sm bg-muted/40">
                  {currentDuration > 0 ? (
                    <div
                      className={cn(
                        "h-full rounded-sm transition-all duration-300",
                        isFastest
                          ? "bg-emerald-500/25 dark:bg-emerald-400/20"
                          : "bg-sidebar-accent",
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
              <span className="flex w-[52px] shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                <span>Tokens</span>
                {isRunningSummary ? (
                  <Loader2
                    data-testid="metric-running-spinner"
                    className="h-3 w-3 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : null}
              </span>
              <div className="relative flex min-w-0 flex-1 items-center">
                <div className="h-[14px] w-full overflow-hidden rounded-sm bg-muted/40">
                  {currentTokens > 0 ? (
                    <div
                      className={cn(
                        "h-full rounded-sm transition-all duration-300",
                        isFewestTokens
                          ? "bg-emerald-500/25 dark:bg-emerald-400/20"
                          : "bg-sidebar-accent",
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

          {showTraceTabs && tabsInline ? (
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <TraceViewModeTabs
                  mode={mode}
                  onModeChange={onModeChange}
                  showToolsTab={showToolsTab}
                  className="[&_button]:px-1.5 [&_button]:py-0.5 [&_button]:text-[11px] [&_svg]:h-3 [&_svg]:w-3"
                />
              </div>
              {actionsSlot ? (
                <div className="flex items-center gap-1">{actionsSlot}</div>
              ) : null}
            </div>
          ) : null}

          {footerNote ? (
            <div className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
              {footerNote}
            </div>
          ) : null}
        </div>
      ) : null}

      {showTraceTabs && !tabsInline ? (
        <ChatTraceViewModeHeaderBar
          mode={mode}
          activeVariant="sidebar"
          onModeChange={onModeChange}
          className={!showComparisonChrome ? className : undefined}
        />
      ) : null}
    </>
  );
}
