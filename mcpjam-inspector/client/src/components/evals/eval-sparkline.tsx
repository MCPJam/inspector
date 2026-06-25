import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SparklineGeometry {
  x: number;
  y: number;
  value: number;
}

function buildSparklineGeometry(
  points: number[],
  w: number,
  h: number,
  pad: number,
): SparklineGeometry[] {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  return points.map((value, index) => ({
    value,
    x: pad + (index / (points.length - 1)) * (w - pad * 2),
    y: pad + (1 - (value - min) / span) * (h - pad * 2),
  }));
}

function resolveHoverIndex(
  clientX: number,
  rect: DOMRect,
  pointCount: number,
): number {
  if (pointCount < 2) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  const index = Math.round(ratio * (pointCount - 1));
  return Math.max(0, Math.min(pointCount - 1, index));
}

function sparklineTooltipStyle(leftPercent: number): CSSProperties {
  if (leftPercent <= 20) {
    return { left: `${leftPercent}%`, transform: "translateX(0)" };
  }
  if (leftPercent >= 80) {
    return { left: `${leftPercent}%`, transform: "translateX(-100%)" };
  }
  return { left: `${leftPercent}%`, transform: "translateX(-50%)" };
}

function SparklineTooltip({
  label,
  value,
  leftPercent,
  placement = "below",
  tooltipTestId = "metric-sparkline-tooltip-value",
}: {
  label: string;
  value: ReactNode;
  leftPercent: number;
  placement?: "above" | "below";
  tooltipTestId?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-50",
        placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5",
      )}
      style={sparklineTooltipStyle(leftPercent)}
    >
      <div className="whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-[10px] shadow-md">
        <div className="font-medium text-foreground">{label}</div>
        <div
          className="tabular-nums text-muted-foreground"
          data-testid={tooltipTestId}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function useSparklineHover(pointCount: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const updateHover = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || pointCount < 2) return;
    setHoverIndex(resolveHoverIndex(clientX, rect, pointCount));
  };

  return {
    containerRef,
    hoverIndex,
    onMouseMove: (event: React.MouseEvent<HTMLDivElement>) =>
      updateHover(event.clientX),
    onMouseLeave: () => setHoverIndex(null),
  };
}

function Baseline({ w, h, pad }: { w: number; h: number; pad: number }) {
  return (
    <line
      x1={pad}
      y1={h - pad}
      x2={w - pad}
      y2={h - pad}
      className="text-border"
      stroke="currentColor"
      strokeWidth={1}
    />
  );
}

export function EvalSparkline({
  points,
  pointLabels,
  formatValue,
  tooltipValues,
  testId,
  height = 24,
  strokeClassName = "text-muted-foreground/60",
  tooltipPlacement = "below",
}: {
  points: number[];
  pointLabels: string[];
  formatValue: (value: number) => string;
  /** When set, overrides formatValue for tooltip body (one entry per point). */
  tooltipValues?: ReactNode[];
  testId?: string;
  height?: number;
  strokeClassName?: string;
  tooltipPlacement?: "above" | "below";
}) {
  const w = 120;
  const h = height;
  const pad = 3;
  const geometry = useMemo(() => {
    if (points.length < 2) return [];
    return buildSparklineGeometry(points, w, h, pad);
  }, [points, w, h, pad]);
  const { containerRef, hoverIndex, onMouseMove, onMouseLeave } =
    useSparklineHover(points.length);

  if (points.length < 2) return null;

  const active = hoverIndex != null ? geometry[hoverIndex] : geometry.at(-1);
  const activeLabel =
    hoverIndex != null ? pointLabels[hoverIndex] : pointLabels.at(-1);
  const activeValue =
    hoverIndex != null ? points[hoverIndex] : points.at(-1);
  const activeTooltip =
    hoverIndex != null && tooltipValues
      ? tooltipValues[hoverIndex]
      : tooltipValues?.at(-1);
  const tooltipLeft =
    hoverIndex != null && points.length > 1
      ? (hoverIndex / (points.length - 1)) * 100
      : 100;

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="relative cursor-crosshair"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {hoverIndex != null && activeLabel != null && activeValue != null ? (
        <SparklineTooltip
          label={activeLabel}
          leftPercent={tooltipLeft}
          placement={tooltipPlacement}
          value={
            activeTooltip != null
              ? activeTooltip
              : formatValue(activeValue)
          }
        />
      ) : null}
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden
        className={strokeClassName}
      >
        <Baseline w={w} h={h} pad={pad} />
        <polyline
          points={geometry.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverIndex != null && active ? (
          <>
            <line
              x1={active.x}
              y1={pad}
              x2={active.x}
              y2={h - pad}
              className="stroke-border/80"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle
              cx={active.x}
              cy={active.y}
              r={3}
              className="fill-background stroke-current"
              strokeWidth={1.5}
            />
          </>
        ) : active ? (
          <circle cx={active.x} cy={active.y} r={2} fill="currentColor" />
        ) : null}
      </svg>
    </div>
  );
}

export function EvalDualSparkline({
  primary,
  secondary,
  pointLabels,
  formatPrimary,
  formatSecondary,
  testId,
  height = 28,
  tooltipPlacement = "below",
}: {
  primary: number[];
  secondary: number[];
  pointLabels: string[];
  formatPrimary: (value: number) => string;
  formatSecondary: (value: number) => string;
  testId?: string;
  height?: number;
  tooltipPlacement?: "above" | "below";
}) {
  const w = 120;
  const h = height;
  const pad = 3;
  const { primaryGeometry, secondaryGeometry } = useMemo(() => {
    if (primary.length < 2 || secondary.length < 2) {
      return { primaryGeometry: [], secondaryGeometry: [] };
    }
    const all = [...primary, ...secondary];
    const max = Math.max(...all);
    const min = Math.min(...all);
    const span = max - min || 1;
    const toGeometry = (points: number[]) =>
      points.map((value, index) => ({
        value,
        x: pad + (index / (points.length - 1)) * (w - pad * 2),
        y: pad + (1 - (value - min) / span) * (h - pad * 2),
      }));
    return {
      primaryGeometry: toGeometry(primary),
      secondaryGeometry: toGeometry(secondary),
    };
  }, [primary, secondary, w, h, pad]);
  const { containerRef, hoverIndex, onMouseMove, onMouseLeave } =
    useSparklineHover(primary.length);

  if (primary.length < 2 || secondary.length < 2) return null;

  const activePrimary =
    hoverIndex != null ? primaryGeometry[hoverIndex] : primaryGeometry.at(-1);
  const activeSecondary =
    hoverIndex != null
      ? secondaryGeometry[hoverIndex]
      : secondaryGeometry.at(-1);
  const activeLabel =
    hoverIndex != null ? pointLabels[hoverIndex] : pointLabels.at(-1);
  const tooltipLeft =
    hoverIndex != null && primary.length > 1
      ? (hoverIndex / (primary.length - 1)) * 100
      : 100;

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="relative cursor-crosshair"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {hoverIndex != null &&
      activeLabel != null &&
      activePrimary &&
      activeSecondary ? (
        <SparklineTooltip
          label={activeLabel}
          leftPercent={tooltipLeft}
          placement={tooltipPlacement}
          value={
            <>
              P50 {formatPrimary(activePrimary.value)} · P95{" "}
              {formatSecondary(activeSecondary.value)}
            </>
          }
        />
      ) : null}
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <Baseline w={w} h={h} pad={pad} />
        <polyline
          points={primaryGeometry
            .map((point) => `${point.x},${point.y}`)
            .join(" ")}
          fill="none"
          className="stroke-muted-foreground/45"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={secondaryGeometry
            .map((point) => `${point.x},${point.y}`)
            .join(" ")}
          fill="none"
          className="stroke-foreground/60"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverIndex != null && activePrimary ? (
          <>
            <line
              x1={activePrimary.x}
              y1={pad}
              x2={activePrimary.x}
              y2={h - pad}
              className="stroke-border/80"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle
              cx={activePrimary.x}
              cy={activePrimary.y}
              r={3}
              className="fill-background stroke-muted-foreground/60"
              strokeWidth={1.5}
            />
            {activeSecondary ? (
              <circle
                cx={activeSecondary.x}
                cy={activeSecondary.y}
                r={3}
                className="fill-background stroke-foreground/70"
                strokeWidth={1.5}
              />
            ) : null}
          </>
        ) : (
          <>
            {activePrimary ? (
              <circle
                cx={activePrimary.x}
                cy={activePrimary.y}
                r={2}
                className="fill-muted-foreground/60"
              />
            ) : null}
            {activeSecondary ? (
              <circle
                cx={activeSecondary.x}
                cy={activeSecondary.y}
                r={2}
                className="fill-foreground/70"
              />
            ) : null}
          </>
        )}
      </svg>
    </div>
  );
}
