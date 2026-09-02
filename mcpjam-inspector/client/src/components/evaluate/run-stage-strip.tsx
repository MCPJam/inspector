/**
 * The six stages, across the run, as one line.
 *
 * Sits between the verdict and the case rows because that is the order the two
 * questions arrive in: what broke, then how much of this run was measured at
 * all. Clicking a stage filters the rows to the cases that broke there.
 *
 * Every cell states its population, and a stage with nothing to divide says
 * "not measured" in words. The model refuses to produce a percent for it, and
 * this view has no way to invent one.
 */
import { cn } from "@/lib/utils";

import type { StageStripCell, StageStripView } from "./run-stage-strip-model";

const TONE_BAR: Record<StageStripCell["tone"], string> = {
  measured: "bg-success/70",
  attention: "bg-destructive",
  // Dashed, not empty: an unmeasured stage is a stated absence, and a blank
  // cell would read as a clean one.
  unmeasured: "border-t border-dashed border-border",
};

export function RunStageStrip({
  view,
  activeStage,
  onSelectStage,
}: {
  view: StageStripView;
  activeStage: string | null;
  onSelectStage?: (stage: string | null) => void;
}) {
  if (view.kind === "hidden") return null;

  if (view.kind === "loading") {
    return (
      <div
        className="px-5 py-3 text-[12.5px] text-muted-foreground"
        data-testid="run-stage-strip"
      >
        Reading stage measurements…
      </div>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <div
        className="px-5 py-3 text-[12.5px] text-muted-foreground"
        data-testid="run-stage-strip"
      >
        {view.message}
      </div>
    );
  }

  return (
    <section className="px-5 py-3" data-testid="run-stage-strip">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Stages
        </h4>
        <span className="text-[11.5px] text-muted-foreground">
          counted over {view.trials}{" "}
          {view.trials === 1 ? "iteration" : "iterations"}, so cases with more
          repetitions weigh more
        </span>
        {view.provisional ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-600 dark:text-amber-500">
            provisional
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
        {view.cells.map((cell) => {
          const active = activeStage === cell.stage;
          return (
            <button
              key={cell.stage}
              type="button"
              aria-pressed={active}
              onClick={() => onSelectStage?.(active ? null : cell.stage)}
              data-testid={`run-stage-strip-cell-${cell.stage}`}
              className={cn(
                "rounded-md border px-2.5 py-2 text-left transition-colors",
                active
                  ? "border-foreground bg-muted/60"
                  : "border-border/50 hover:border-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "mb-1.5 block h-[3px] rounded",
                  TONE_BAR[cell.tone],
                )}
              />
              <span className="block text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {cell.label}
              </span>
              <span
                className={cn(
                  "mt-0.5 block text-[12.5px] tabular-nums",
                  cell.tone === "attention"
                    ? "font-semibold text-destructive"
                    : "text-foreground",
                )}
              >
                {cell.measured}
              </span>
              {cell.notReached ? (
                <span className="block text-[11px] text-muted-foreground">
                  {cell.notReached}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
