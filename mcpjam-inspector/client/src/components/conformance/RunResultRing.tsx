/**
 * A small ring of the last run's applicable checks: passed, failed, and
 * the ones that could not run. The fraction beside it is the same count.
 */

import type { ConformanceRunListItem } from "./ConformanceHistory";

const SIZE = 24;
const STROKE = 3.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

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

export function RunResultRing({ run }: { run: ConformanceRunListItem }) {
  if (run.status !== "completed") {
    return <RunStatusLabel status={run.status} />;
  }
  const parts = slices(run);
  const center = SIZE / 2;
  let drawn = 0;

  return (
    <svg
      role="img"
      aria-label={runResultRingLabel(run)}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="size-6 shrink-0"
    >
      <circle
        cx={center}
        cy={center}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        className="stroke-border"
      />
      {parts.map((slice) => {
        const length = (slice.count / run.applicable) * CIRCUMFERENCE;
        const start = drawn;
        drawn += slice.count;
        if (parts.length === 1) {
          return (
            <circle
              key={slice.className}
              cx={center}
              cy={center}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className={slice.className}
            />
          );
        }
        return (
          <circle
            key={slice.className}
            cx={center}
            cy={center}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
            transform={`rotate(${(start / run.applicable) * 360 - 90} ${center} ${center})`}
            className={slice.className}
          />
        );
      })}
    </svg>
  );
}
