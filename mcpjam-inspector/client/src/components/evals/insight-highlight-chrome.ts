import { cn } from "@/lib/utils";

/** Flat insight surface — matches eval-surface-chrome (hairline border, no gradient/ring/shadow). */
export const insightHighlightSectionClass = cn(
  "relative rounded-2xl border border-border/50 bg-card text-card-foreground",
  "dark:border-border/40",
);

/** Accent rail removed — kept as an empty class so call sites stay stable. */
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
  "px-3 pb-3 pt-1 border-t border-border/40 dark:border-border/30";

export const insightHighlightNarrativeClass =
  "text-sm leading-relaxed text-foreground";
