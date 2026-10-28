import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Decorative "overall score" card for the pre-run state. Nothing here is a
 * real result: each suite's value drifts toward a random target so the card
 * reads like a review in progress. Reduced-motion users get a still frame.
 */

const SUITES = ["Protocol", "Apps", "Tasks", "OAuth"] as const;
const BAR_COUNT = 5;
const TOTAL_CHECKS = 8;
const TICK_MS = 50;
const RETARGET_MS = 1400;

function randomTarget() {
  return 35 + Math.random() * 65;
}

function toneFor(value: number) {
  if (value >= 80) return "bg-emerald-500";
  if (value >= 50) return "bg-amber-500";
  return "bg-red-500";
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function useDriftingValues(count: number) {
  const [values, setValues] = useState<number[]>(() =>
    Array.from({ length: count }, randomTarget),
  );

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let targets = Array.from({ length: count }, randomTarget);
    const retarget = setInterval(() => {
      targets = targets.map(randomTarget);
    }, RETARGET_MS);
    const tick = setInterval(() => {
      setValues((current) =>
        current.map((value, i) => value + (targets[i] - value) * 0.12),
      );
    }, TICK_MS);
    return () => {
      clearInterval(retarget);
      clearInterval(tick);
    };
  }, [count]);

  return values;
}

function SuiteMeter({ value }: { value: number }) {
  const filled = Math.max(1, Math.ceil(value / (100 / BAR_COUNT)));
  return (
    <div className="flex h-4 shrink-0 items-end gap-0.5">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-1.5 rounded-[2px] transition-colors duration-300",
            i < filled ? toneFor(value) : "bg-muted",
          )}
          style={{ height: `${40 + i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function ConformanceScorePreview() {
  const values = useDriftingValues(SUITES.length);
  const overall = values.reduce((sum, v) => sum + v, 0) / values.length;
  const passed = Math.round((overall / 100) * TOTAL_CHECKS);

  return (
    <div
      aria-hidden="true"
      className="flex w-75 shrink-0 select-none flex-col gap-3 rounded-lg border border-border bg-popover px-4 pt-3.5 pb-3"
    >
      <div className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
        OVERALL SCORE
      </div>
      <div className="flex items-end gap-2">
        <div className="flex items-start">
          <span className="text-[32px] leading-8 font-semibold tracking-[-0.03em] tabular-nums">
            {Math.round(overall)}
          </span>
          <span className="pt-0.5 text-sm font-semibold text-muted-foreground">
            %
          </span>
        </div>
        <span className="pb-0.5 text-xs font-medium text-muted-foreground tabular-nums">
          {passed}/{TOTAL_CHECKS}
        </span>
      </div>
      <div className="flex flex-col border-t border-border/60 pt-1.5">
        {SUITES.map((suite, i) => (
          <div key={suite} className="flex h-6.5 items-center gap-3">
            <span className="grow text-[13px] font-medium">{suite}</span>
            <SuiteMeter value={values[i]} />
          </div>
        ))}
      </div>
    </div>
  );
}
