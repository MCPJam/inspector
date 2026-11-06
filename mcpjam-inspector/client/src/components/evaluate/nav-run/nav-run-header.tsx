/**
 * The Suite run page's heading on the new pages: "Suite Run #N" with the
 * suite in a pill, and Compare runs with what changed sliding in beside it.
 */
import { Layers, TrendingUp } from "lucide-react";

export function NavRunTitle({
  runLabel,
  suiteName,
}: {
  /** "Suite Run #4", or today's "Run …" when the run has no number. */
  runLabel: string;
  suiteName: string;
}) {
  return (
    <>
      <h2 className="min-w-0 truncate text-2xl font-bold leading-8 tracking-tight text-foreground">
        {runLabel}
      </h2>
      <span
        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 text-xs text-muted-foreground"
        title="Suite"
      >
        <Layers className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">Suite: </span>
        <span className="truncate">{suiteName}</span>
      </span>
    </>
  );
}

/**
 * Compare runs, previewing "vs run #N · what changed" to its left on hover or
 * focus. The preview floats, so the header never reflows under the cursor.
 */
export function NavCompareButton({
  canCompare,
  tease,
  onClick,
}: {
  canCompare: boolean;
  tease: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!canCompare}
      onClick={onClick}
      title={canCompare ? undefined : "Need at least two runs"}
      data-testid="evaluate-run-compare-open"
      className="group/compare relative inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      {tease ? (
        <span
          data-testid="run-change-summary"
          className="pointer-events-none absolute right-full top-1/2 z-20 mr-1 -translate-y-1/2 translate-x-2 whitespace-nowrap rounded-full border border-border bg-popover px-2.5 py-0.5 text-xs font-normal text-muted-foreground opacity-0 shadow-sm [transition:opacity_160ms_ease,translate_200ms_ease] group-hover/compare:translate-x-0 group-hover/compare:opacity-100 group-focus-visible/compare:translate-x-0 group-focus-visible/compare:opacity-100 motion-reduce:[transition:none]"
        >
          {tease}
        </span>
      ) : null}
      <TrendingUp className="mr-1.5 size-3.5" aria-hidden />
      Compare runs
    </button>
  );
}
