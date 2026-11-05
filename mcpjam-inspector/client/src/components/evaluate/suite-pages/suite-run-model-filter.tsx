import { cn } from "@/lib/utils";
import {
  resultCounts,
  type RunResultsMatrixData,
} from "../run-results-matrix-model";

type Target = RunResultsMatrixData["targets"][number];

function passedOf(targets: readonly Target[]): string {
  const iterations = targets.flatMap((target) => target.iterations);
  return `${resultCounts(iterations).passed}/${iterations.length}`;
}

/**
 * The Suite run page's one model filter. Stats, findings and Test runs all
 * follow it, so the reader picks a model once instead of per section.
 */
export function SuiteRunModelFilter({
  targets,
  selectedKey,
  onSelect,
}: {
  targets: readonly Target[];
  /** Null shows every model. */
  selectedKey: string | null;
  onSelect: (target: Target | null) => void;
}) {
  if (targets.length < 2) return null;
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "border-primary/40 bg-primary/10 text-foreground"
        : "border-border bg-card text-foreground hover:bg-muted/60",
    );
  return (
    <div
      role="group"
      aria-label="Showing"
      className="flex flex-wrap items-center gap-2 px-5 pb-3"
      data-testid="suite-run-model-filter"
    >
      <span className="text-[12.5px] text-muted-foreground">Showing</span>
      <button
        type="button"
        aria-pressed={selectedKey === null}
        className={chip(selectedKey === null)}
        onClick={() => onSelect(null)}
      >
        All models
        <span className="tabular-nums text-muted-foreground">
          {passedOf(targets)}
        </span>
      </button>
      {targets.map((target) => (
        <button
          type="button"
          key={target.key}
          aria-pressed={selectedKey === target.key}
          className={chip(selectedKey === target.key)}
          onClick={() => onSelect(target)}
        >
          {`${target.client} · ${target.model}`}
          <span className="tabular-nums text-muted-foreground">
            {passedOf([target])}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Names the run the stats are measured against, and how to read them. */
export function SuiteRunComparisonLine({
  baseRunNumber,
}: {
  baseRunNumber: number | null | undefined;
}) {
  if (!baseRunNumber) return null;
  return (
    <p
      className="px-5 pb-3 text-[12.5px] text-muted-foreground"
      data-testid="suite-run-comparison"
    >
      vs run #{baseRunNumber} · <span className="text-success">green</span>{" "}
      better, <span className="text-destructive">red</span> worse
    </p>
  );
}
