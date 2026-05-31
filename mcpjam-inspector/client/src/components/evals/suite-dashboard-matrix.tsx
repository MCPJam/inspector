import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./helpers";
import type {
  MatrixIterationResult,
  SuiteDashboardMatrixCell,
  SuiteDashboardMatrixData,
  SuiteDashboardMatrixMetric,
} from "./suite-dashboard-data";

export interface SuiteDashboardMatrixProps {
  matrix: SuiteDashboardMatrixData;
  className?: string;
}

const CASE_COLUMN_WIDTH_PX = 280;
const MODEL_COLUMN_MIN_PX = 220;

function getModelColumnMinWidth(modelCount: number): number {
  if (modelCount <= 1) {
    return 360;
  }
  if (modelCount <= 2) {
    return 280;
  }
  return MODEL_COLUMN_MIN_PX;
}

function buildMatrixGridTemplateColumns(modelCount: number): string {
  const modelMin = getModelColumnMinWidth(modelCount);
  return `${CASE_COLUMN_WIDTH_PX}px repeat(${modelCount}, minmax(${modelMin}px, 1fr))`;
}

function matrixMinWidth(modelCount: number): number {
  const modelMin = getModelColumnMinWidth(modelCount);
  return CASE_COLUMN_WIDTH_PX + modelCount * modelMin;
}

const MODEL_HEADER_COLORS = [
  "text-muted-foreground",
  "text-muted-foreground",
  "text-muted-foreground",
  "text-muted-foreground",
] as const;

const EMPTY_CELL: SuiteDashboardMatrixCell = {
  caseId: "",
  modelKey: "",
  passed: 0,
  failed: 0,
  total: 0,
  passRate: null,
  p50Ms: null,
  p95Ms: null,
  tokensUsed: 0,
  inputTokens: 0,
  outputTokens: 0,
  validatorCount: 0,
  iterationResults: [],
};

function formatLatencySeconds(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function formatTokenCompact(tokens: number): string {
  if (tokens <= 0) {
    return "—";
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

function passScoreClassName(passed: number, total: number) {
  if (total === 0) {
    return "text-muted-foreground";
  }
  return "text-foreground";
}

function latencyValueClassName(ms: number, kind: "p50" | "p95") {
  const seconds = ms / 1000;
  if (kind === "p50") {
    if (seconds > 2.5) {
      return "text-foreground";
    }
    if (seconds > 1.8) {
      return "text-foreground";
    }
  } else if (seconds > 4) {
    return "text-foreground";
  } else if (seconds > 3) {
    return "text-foreground";
  }
  return "text-foreground";
}

function metricChipLabel(metrics: SuiteDashboardMatrixMetric[]): string {
  const labels: string[] = ["pass"];
  if (metrics.includes("latency")) {
    labels.push("latency");
  }
  if (metrics.includes("tokens")) {
    labels.push("tokens");
  }
  if (metrics.includes("validators")) {
    labels.push("validators");
  }
  return labels.join(" · ");
}

function MatrixIterationDots({
  results,
}: {
  results: MatrixIterationResult[];
}) {
  if (results.length === 0) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-hidden>
      {results.map((result, index) => (
        <span
          key={index}
          className={cn(
            "inline-block size-3 rounded-[4px] border box-border",
            result === "pass" &&
              "border-emerald-700/25 bg-emerald-600/55 dark:bg-emerald-300/45",
            result === "fail" &&
              "border-rose-700/25 bg-rose-600/55 dark:bg-rose-300/45",
            result === "pending" &&
              "border-muted-foreground/45 bg-transparent",
            result === "cancelled" &&
              "border-muted-foreground/35 bg-muted",
          )}
        />
      ))}
    </span>
  );
}

function MatrixCellContent({
  cell,
  showLatency,
  showTokens,
  showValidators,
}: {
  cell: SuiteDashboardMatrixCell;
  showLatency: boolean;
  showTokens: boolean;
  showValidators: boolean;
}) {
  if (cell.total === 0) {
    return (
      <div className="flex h-full min-h-[84px] items-center px-3 py-2.5 text-sm text-muted-foreground">
        —
      </div>
    );
  }

  const tokenTotal =
    cell.inputTokens + cell.outputTokens > 0
      ? cell.inputTokens + cell.outputTokens
      : cell.tokensUsed;

  return (
    <div className="flex min-h-[66px] flex-col gap-2 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <MatrixIterationDots results={cell.iterationResults} />
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-sm font-bold tabular-nums",
              passScoreClassName(cell.passed, cell.total),
            )}
          >
            {cell.passed}/{cell.total}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {showLatency && (cell.p50Ms !== null || cell.p95Ms !== null) ? (
          <span className="tabular-nums">
            p50/p95{" "}
            <span
              className={cn(
                "font-medium",
                cell.p50Ms !== null
                  ? latencyValueClassName(cell.p50Ms, "p50")
                  : "text-muted-foreground",
              )}
            >
              {cell.p50Ms !== null ? formatLatencySeconds(cell.p50Ms) : "—"}
            </span>
            /
            <span
              className={cn(
                "font-medium",
                cell.p95Ms !== null
                  ? latencyValueClassName(cell.p95Ms, "p95")
                  : "text-muted-foreground",
              )}
            >
              {cell.p95Ms !== null ? formatLatencySeconds(cell.p95Ms) : "—"}
            </span>
          </span>
        ) : null}
        {showTokens && tokenTotal > 0 ? (
          <span className="tabular-nums">
            tok{" "}
            <span className="font-medium text-foreground">
              {formatTokenCompact(tokenTotal)}
            </span>
          </span>
        ) : null}
        {showValidators ? (
          <span
            className={cn(
              "tabular-nums",
              cell.validatorCount > 0
                ? "text-muted-foreground"
                : "text-muted-foreground",
            )}
          >
            {cell.validatorCount > 0 ? `${cell.validatorCount} flags` : "clean"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MatrixAggregateCell({
  cell,
  modelIndex,
  showLatency,
  showTokens,
}: {
  cell: SuiteDashboardMatrixCell;
  modelIndex: number;
  showLatency: boolean;
  showTokens: boolean;
}) {
  const passPercent =
    cell.passRate !== null ? Math.round(cell.passRate * 100) : null;

  return (
    <div className="flex min-h-[84px] flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "text-lg font-bold tabular-nums",
            MODEL_HEADER_COLORS[modelIndex % MODEL_HEADER_COLORS.length],
          )}
        >
          {passPercent !== null ? `${passPercent}%` : "—"}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          pass
        </span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
          {cell.total > 0 ? `${cell.passed}/${cell.total}` : null}
        </span>
      </div>

      {(showLatency || showTokens) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
          {showLatency && (cell.p50Ms !== null || cell.p95Ms !== null) ? (
            <span>
              <span className="font-semibold text-foreground">
                {cell.p50Ms !== null ? formatLatencySeconds(cell.p50Ms) : "—"}
              </span>
              /
              <span className="font-semibold text-foreground">
                {cell.p95Ms !== null ? formatLatencySeconds(cell.p95Ms) : "—"}
              </span>
            </span>
          ) : null}
          {showTokens && cell.tokensUsed > 0 ? (
            <span>
              <span className="font-semibold text-foreground">
                {formatTokenCompact(cell.tokensUsed)}
              </span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function SuiteDashboardMatrix({ matrix, className }: SuiteDashboardMatrixProps) {
  const cellByKey = useMemo(() => {
    const map = new Map<string, SuiteDashboardMatrixCell>();
    for (const cell of matrix.cells) {
      map.set(`${cell.caseId}:${cell.modelKey}`, cell);
    }
    return map;
  }, [matrix.cells]);

  const aggregateByModelKey = useMemo(() => {
    const map = new Map<string, SuiteDashboardMatrixData["modelAggregates"][number]>();
    for (const aggregate of matrix.modelAggregates) {
      map.set(aggregate.modelKey, aggregate);
    }
    return map;
  }, [matrix.modelAggregates]);

  const hasMatrixContent =
    matrix.caseRows.length > 0 && matrix.modelColumns.length > 0;
  const showLatency = matrix.availableMetrics.includes("latency");
  const showTokens = matrix.availableMetrics.includes("tokens");
  const showValidators = matrix.availableMetrics.includes("validators");
  const totalRuns = matrix.cells.reduce((sum, cell) => sum + cell.total, 0);
  const lastRunLabel = matrix.latestCompletedRun
    ? `last run · #${matrix.latestCompletedRun.runNumber} · ${formatRelativeTime(
        matrix.latestCompletedRun.completedAt ??
          matrix.latestCompletedRun.createdAt,
      ).toLowerCase()}`
    : "no completed runs yet";

  const modelCount = matrix.modelColumns.length;
  const gridTemplateColumns = buildMatrixGridTemplateColumns(modelCount);
  const tableMinWidth = matrixMinWidth(modelCount);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card text-card-foreground",
        className,
      )}
      data-testid="suite-dashboard-matrix"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {lastRunLabel}
        </span>
        <span className="rounded-md border border-border/70 bg-muted/30 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          show: {metricChipLabel(matrix.availableMetrics)}
        </span>
        <div className="flex-1" />
        {hasMatrixContent ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            models: {matrix.modelColumns.length} · cases:{" "}
            {matrix.caseRows.length} · {totalRuns} runs
          </span>
        ) : null}
      </div>

      {!hasMatrixContent ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          Add cases and models to see the dashboard matrix.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div
            className="w-full"
            style={{ minWidth: tableMinWidth }}
          >
            <div
              className="grid border-b-2 border-border"
              style={{ gridTemplateColumns }}
            >
              <div className="sticky left-0 z-10 bg-card px-4 py-2.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                Case
              </div>
              {matrix.modelColumns.map((column, index) => (
                <div
                  key={column.modelKey}
                  className="border-l border-dashed border-border/80 px-3 py-2"
                >
                  <div
                    className={cn(
                      "truncate text-sm font-semibold",
                      MODEL_HEADER_COLORS[index % MODEL_HEADER_COLORS.length],
                    )}
                  >
                    {column.modelLabel}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                    pass · p50/p95 · in/out tok
                  </div>
                </div>
              ))}
            </div>

            {matrix.caseRows.map((caseRow) => (
              <div
                key={caseRow.caseId}
                className="grid border-b border-border/60"
                style={{ gridTemplateColumns }}
              >
                <div className="sticky left-0 z-10 flex items-center bg-card px-4 py-2.5">
                  <div className="truncate text-sm font-medium text-foreground">
                    {caseRow.title}
                  </div>
                </div>
                {matrix.modelColumns.map((column) => {
                  const cell =
                    cellByKey.get(`${caseRow.caseId}:${column.modelKey}`) ??
                    {
                      ...EMPTY_CELL,
                      caseId: caseRow.caseId,
                      modelKey: column.modelKey,
                    };

                  return (
                    <div
                      key={`${caseRow.caseId}:${column.modelKey}`}
                      className="border-l border-dashed border-border/60"
                      data-testid={`matrix-cell-${caseRow.caseId}-${column.modelKey}`}
                    >
                      <MatrixCellContent
                        cell={cell}
                        showLatency={showLatency}
                        showTokens={showTokens}
                        showValidators={showValidators}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            <div
              className="grid border-t-2 border-border bg-muted/25"
              style={{ gridTemplateColumns }}
            >
              <div className="sticky left-0 z-10 flex items-center bg-muted/25 px-4 py-2.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                Aggregate · this run
              </div>
              {matrix.modelColumns.map((column, modelIndex) => {
                const aggregate = aggregateByModelKey.get(column.modelKey);
                const aggregateCell: SuiteDashboardMatrixCell = aggregate
                  ? { ...aggregate, caseId: "", iterationResults: [] }
                  : EMPTY_CELL;

                return (
                  <div
                    key={`aggregate-${column.modelKey}`}
                    className="border-l border-dashed border-border/80"
                    data-testid={`matrix-aggregate-${column.modelKey}`}
                  >
                    <MatrixAggregateCell
                      cell={aggregateCell}
                      modelIndex={modelIndex}
                      showLatency={showLatency}
                      showTokens={showTokens}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
