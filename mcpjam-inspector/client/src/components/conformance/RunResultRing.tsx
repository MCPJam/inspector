/**
 * A small ring of the last run's applicable checks: passed, failed, and
 * the ones that could not run. The fraction beside it is the same count.
 */

import { useEffect, useState } from "react";
import type { ConformanceRunListItem } from "./ConformanceHistory";

const SIZE = 24;
const STROKE = 3.5;
const DRAW_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 0 to 1, once, with a cubic ease-out. Stays at 1 when animation is off. */
function useDrawProgress(animate: boolean): number {
  const [progress, setProgress] = useState(() =>
    !animate || prefersReducedMotion() ? 1 : 0,
  );
  useEffect(() => {
    if (!animate || prefersReducedMotion()) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DRAW_MS);
      setProgress(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate]);
  return progress;
}

type Slice = {
  count: number;
  tone: "passed" | "failed" | "could not run";
  className: string;
};

function slices(run: ConformanceRunListItem): Slice[] {
  if (run.applicable <= 0) return [];
  const passed = Math.min(Math.max(run.passed, 0), run.applicable);
  const failed = Math.min(Math.max(run.failed, 0), run.applicable - passed);
  const couldNotRun = run.applicable - passed - failed;
  const all: Slice[] = [
    { count: passed, tone: "passed", className: "stroke-success" },
    { count: failed, tone: "failed", className: "stroke-destructive" },
    {
      count: couldNotRun,
      tone: "could not run",
      className: "stroke-warning",
    },
  ];
  return all.filter((slice) => slice.count > 0);
}

export function runResultRingLabel(run: ConformanceRunListItem): string {
  if (run.applicable <= 0) return "No applicable checks";
  const parts = slices(run).map((slice) => `${slice.count} ${slice.tone}`);
  return `${parts.join(", ")} of ${run.applicable}`;
}

/**
 * A run that has not finished has no counts yet (or only some), so a ring
 * would read like a server with nothing to check. Name the state instead.
 */
function RunStatusLabel({ status }: { status: string }) {
  const base =
    "inline-flex h-5.5 shrink-0 items-center rounded-sm px-2 text-[11px] font-semibold tracking-[0.06em]";
  if (status === "timed_out") {
    return (
      <span
        className={`${base} bg-amber-400/25 text-amber-700 dark:text-amber-400`}
      >
        TIMED OUT
      </span>
    );
  }
  return (
    <span className={`${base} bg-muted text-muted-foreground`}>
      {status === "cancelled" ? "CANCELLED" : "RUNNING"}
    </span>
  );
}

export function RunResultRing({
  run,
  size = SIZE,
  label,
  animate = false,
}: {
  run: ConformanceRunListItem;
  /** Drawn size. The home and history rings stay at 24. */
  size?: number;
  /** Percent drawn in the middle. Omit on the small ring. */
  label?: string;
  /** Draw the slices in clockwise on mount. The small rings stay still. */
  animate?: boolean;
}) {
  // Before the early return: a run goes from queued to completed while this
  // ring stays mounted, so the hook count must not depend on the status.
  const progress = useDrawProgress(animate);
  if (run.status !== "completed") {
    return <RunStatusLabel status={run.status} />;
  }
  const parts = slices(run);
  const stroke = label ? Math.round(size * 0.07) : STROKE;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  let drawn = 0;
  const breakdown = runResultRingLabel(run);

  return (
    <svg
      role="img"
      aria-label={label ? `${label}. ${breakdown}` : breakdown}
      viewBox={`0 0 ${size} ${size}`}
      className={size === SIZE ? "size-6 shrink-0" : "shrink-0"}
      style={size === SIZE ? undefined : { width: size, height: size }}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-border"
      />
      {parts.map((slice) => {
        const length = (slice.count / run.applicable) * circumference;
        const start = drawn;
        drawn += slice.count;
        const visible =
          progress >= 1
            ? length
            : Math.max(
                0,
                Math.min(
                  length,
                  progress * circumference -
                    (start / run.applicable) * circumference,
                ),
              );
        if (visible <= 0) return null;
        // A dash the length of the path does not close, so a finished
        // single slice is a solid circle.
        if (parts.length === 1 && progress >= 1) {
          return (
            <circle
              key={slice.className}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              className={slice.className}
            />
          );
        }
        return (
          <circle
            key={slice.className}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={`${visible} ${circumference - visible}`}
            transform={`rotate(${(start / run.applicable) * 360 - 90} ${center} ${center})`}
            className={slice.className}
          />
        );
      })}
      {label ? (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-base font-semibold"
          style={{ fontSize: 16 }}
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}
