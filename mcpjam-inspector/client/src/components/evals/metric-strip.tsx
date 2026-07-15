import { cn } from "@/lib/utils";
import { evalSurfaceCardClass } from "./eval-surface-chrome";
import { EvalDualSparkline, EvalSparkline } from "./eval-sparkline";
import {
  formatCompactNumber,
  formatDurationMs,
  type MetricStripData,
  type MetricStripPoint,
} from "./metric-strip-data";

function LatencyTrendMetric({
  p50,
  p95,
  p50Series,
  p95Series,
  pointLabels,
  showTrend,
  compact,
  layout = "horizontal",
  matrixCell = false,
}: {
  p50: number | null;
  p95: number | null;
  p50Series: number[];
  p95Series: number[];
  pointLabels: string[];
  showTrend: boolean;
  compact?: boolean;
  layout?: "horizontal" | "vertical";
  matrixCell?: boolean;
}) {
  const valueClass = cn(
    "font-semibold leading-none tabular-nums tracking-tight text-foreground",
    matrixCell ? "text-[12px]" : compact ? "text-[15px]" : "text-[17px]",
  );

  const latencyRow = (label: string, value: number | null) => (
    <div className="flex min-w-0 items-baseline gap-1">
      <span className="shrink-0 text-[9px] font-medium tabular-nums text-muted-foreground">
        {label}
      </span>
      <span className={cn(valueClass, "min-w-0 truncate")}>
        {value != null ? formatDurationMs(value) : "—"}
      </span>
    </div>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-between",
        layout === "horizontal" && "border-l border-border/60",
        matrixCell ? "px-2 py-2" : compact ? "px-3 py-2.5" : "px-4 py-3.5",
      )}
      data-testid="metric-strip-latency"
    >
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Latency
        </div>
        <div
          className={cn(
            matrixCell
              ? "mt-1 flex flex-col gap-0.5"
              : cn("mt-2 flex items-baseline", compact ? "gap-3" : "gap-4"),
          )}
        >
          {matrixCell ? (
            <>
              {latencyRow("P50", p50)}
              {latencyRow("P95", p95)}
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                  P50
                </span>
                <span className={valueClass}>
                  {p50 != null ? formatDurationMs(p50) : "—"}
                </span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                  P95
                </span>
                <span className={valueClass}>
                  {p95 != null ? formatDurationMs(p95) : "—"}
                </span>
              </div>
            </>
          )}
        </div>
        {!matrixCell ? (
          <div className="mt-1 text-[10.5px] text-muted-foreground">
            per run
          </div>
        ) : null}
      </div>
      {showTrend ? (
        <div className={cn("relative overflow-visible", matrixCell ? "mt-1.5" : "mt-2.5")}>
          <EvalDualSparkline
            primary={p50Series}
            secondary={p95Series}
            pointLabels={pointLabels}
            formatPrimary={formatDurationMs}
            formatSecondary={formatDurationMs}
            testId="metric-sparkline-latency"
          />
        </div>
      ) : null}
    </div>
  );
}

function TrendMetric({
  label,
  value,
  sub,
  chart,
  compact,
  layout = "horizontal",
  matrixCell = false,
}: {
  label: string;
  value: string;
  sub?: string;
  chart?: React.ReactNode;
  compact?: boolean;
  layout?: "horizontal" | "vertical";
  matrixCell?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-between",
        layout === "horizontal" && "border-l border-border/60",
        matrixCell ? "px-2 py-2" : compact ? "px-3 py-2.5" : "px-4 py-3.5",
      )}
    >
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            "mt-1 font-semibold leading-none tabular-nums tracking-tight text-foreground",
            matrixCell ? "truncate text-[12px]" : compact ? "text-[15px]" : "text-[17px]",
          )}
        >
          {value}
        </div>
        {sub && !matrixCell ? (
          <div className="mt-1 text-[10.5px] tabular-nums text-muted-foreground">
            {sub}
          </div>
        ) : null}
      </div>
      {chart ? (
        <div className={cn("relative overflow-visible", matrixCell ? "mt-1.5" : "mt-2.5")}>
          {chart}
        </div>
      ) : null}
    </div>
  );
}

export function MetricStrip({
  data,
  density = "default",
  layout = "horizontal",
  surface = "card",
  testId = "metric-strip",
}: {
  data: MetricStripData | null;
  density?: "default" | "compact";
  layout?: "horizontal" | "vertical";
  /** `embedded` drops outer card chrome (matrix cells). */
  surface?: "card" | "embedded";
  testId?: string;
}) {
  if (!data) return null;

  const compact = density === "compact";
  const vertical = layout === "vertical";
  const matrixCell = surface === "embedded" && vertical;
  const {
    latest,
    series,
    delta,
    showTrend,
    runLabels: runLabelsOverride,
  } = data;
  const seriesOf = (pick: (p: MetricStripPoint) => number) => series.map(pick);
  const tokenSeries = seriesOf((p) => p.tokens);
  const tokenHeadline = latest.tokens;
  const tokenSub = "per run";
  const toolCallSeries = seriesOf((p) => p.toolCalls);
  const toolCallHeadline = latest.toolCalls;
  const toolCallSub = "per run";
  const runLabels =
    runLabelsOverride ?? series.map((_, index) => `Run ${index + 1}`);

  const failing = latest.failed > 0;
  const verdict = failing ? `${latest.failed} failing` : "All passing";

  const deltaBadge =
    delta != null && delta !== 0 ? (
      <span
        className={cn(
          "text-[10px] font-medium tabular-nums",
          delta > 0 ? "text-success" : "text-destructive",
        )}
      >
        {delta > 0 ? "↑" : "↓"}
        {Math.abs(delta)}
      </span>
    ) : null;

  const verdictBadge = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-semibold",
        matrixCell
          ? cn("text-[10px]", failing ? "text-destructive" : "text-success")
          : cn(
              "rounded-full px-2 py-0.5 text-[11px] text-foreground",
              failing ? "bg-destructive/50" : "bg-success/50",
            ),
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          failing ? "bg-destructive" : "bg-success",
        )}
      />
      {verdict}
    </span>
  );

  const passRateHeadline = (
    <span
      className={cn(
        "shrink-0 font-semibold leading-none tabular-nums tracking-tight text-foreground",
        matrixCell
          ? "text-[14px]"
          : compact
            ? vertical
              ? "text-[15px]"
              : "text-[22px]"
            : "text-[28px]",
      )}
    >
      {latest.passRate}%
    </span>
  );

  const passRateSub = (
    <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
      {latest.passed}/{latest.total} passed
    </span>
  );

  const passSection = (
    <div
      className={cn(
        "flex flex-col justify-between",
        matrixCell ? "gap-1.5 px-3 py-2" : compact ? "gap-3 px-3.5 py-2.5" : "gap-3 px-5 py-3.5",
        vertical && !matrixCell && "gap-2",
      )}
      data-testid="metric-strip-pass-rate"
    >
      {vertical ? (
        matrixCell ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {verdictBadge}
              {deltaBadge}
            </div>
            <div className="flex shrink-0 items-baseline gap-1.5">
              {passRateHeadline}
              {passRateSub}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {verdictBadge}
            {deltaBadge}
            {passRateHeadline}
            {passRateSub}
          </div>
        )
      ) : (
        <>
          <div className="flex items-center gap-2">
            {verdictBadge}
            {deltaBadge}
          </div>
          <div className="flex items-baseline gap-2">
            {passRateHeadline}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {latest.passed}/{latest.total} passed
            </span>
          </div>
        </>
      )}
      {showTrend ? (
        <div className="relative overflow-visible">
          <EvalSparkline
            points={seriesOf((p) => p.passRate)}
            pointLabels={runLabels}
            formatValue={(value) => `${value}%`}
            testId="metric-sparkline-pass-rate"
          />
        </div>
      ) : null}
    </div>
  );

  const metricSections = (
    <>
      <LatencyTrendMetric
        p50={latest.latencyP50}
        p95={latest.latencyP95}
        p50Series={series.map((p) => p.latencyP50 ?? 0)}
        p95Series={series.map((p) => p.latencyP95 ?? 0)}
        pointLabels={runLabels}
        showTrend={showTrend}
        compact={compact}
        layout={layout}
        matrixCell={matrixCell}
      />
      <TrendMetric
        label="Tokens"
        value={formatCompactNumber(tokenHeadline)}
        sub={tokenSub}
        compact={compact}
        layout={layout}
        matrixCell={matrixCell}
        chart={
          showTrend ? (
            <EvalSparkline
              points={tokenSeries}
              pointLabels={runLabels}
              formatValue={formatCompactNumber}
              testId="metric-sparkline-tokens"
            />
          ) : null
        }
      />
      <TrendMetric
        label="Tool calls"
        value={formatCompactNumber(toolCallHeadline)}
        sub={toolCallSub}
        compact={compact}
        layout={layout}
        matrixCell={matrixCell}
        chart={
          showTrend ? (
            <EvalSparkline
              points={toolCallSeries}
              pointLabels={runLabels}
              formatValue={formatCompactNumber}
              testId="metric-sparkline-tool-calls"
            />
          ) : null
        }
      />
    </>
  );

  return (
    <div
      data-testid={testId}
      className={cn(
        surface === "card" && evalSurfaceCardClass,
        showTrend ? "overflow-visible" : surface === "card" ? "overflow-hidden" : "overflow-visible",
        vertical
          ? "flex flex-col divide-y divide-border/60"
          : compact
            ? "grid grid-cols-2 sm:grid-cols-[1.2fr_1fr_1fr_1fr]"
            : "grid grid-cols-[1.4fr_1fr_1fr_1fr]",
      )}
    >
      {passSection}
      {vertical ? (
        <div className="grid min-w-0 grid-cols-3 divide-x divide-border/60 [&>*]:min-w-0">
          {metricSections}
        </div>
      ) : (
        metricSections
      )}
    </div>
  );
}
