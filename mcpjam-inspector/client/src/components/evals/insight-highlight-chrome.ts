import { cn } from "@/lib/utils";

/**
 * Neutral card surface matching the rest of the suite dashboard. The AI nature
 * is signaled by the Sparkles icon + "AI" badge in the header rather than a
 * loud amber fill, so the section stays cohesive with the metric strip and
 * cross-client matrix.
 */
export const insightHighlightSectionClass = cn(
  "relative rounded-2xl border border-border/50 bg-card text-card-foreground",
  "dark:border-border/40",
);

/** No colored rail — kept as a no-op element so callers don't need changes. */
export const insightHighlightAccentClass = "hidden";

export const insightHighlightHeaderRowClass =
  "flex items-stretch gap-0 rounded-t-2xl";

export const insightHighlightTriggerClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-t-2xl px-3 py-2.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring";

export const insightHighlightTitleClass =
  "text-sm font-medium text-foreground";

export const insightHighlightSubtitleClass =
  "mt-0.5 truncate text-xs text-muted-foreground";

export const insightHighlightBodyClass =
  "px-3 pb-3 pt-1 border-t border-border/40";

export const insightHighlightNarrativeClass =
  "text-sm leading-snug text-foreground";

/** Compact always-visible callout (suite dashboard). */
export const insightHighlightCompactSectionClass = cn(
  "rounded-lg border border-border/40 bg-muted/20 px-3 py-2",
  "dark:border-border/35 dark:bg-muted/10",
);

export const insightHighlightCompactLabelClass =
  "shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
