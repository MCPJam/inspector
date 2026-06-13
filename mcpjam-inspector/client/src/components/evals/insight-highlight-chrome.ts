import { cn } from "@/lib/utils";

/**
 * Warm amber surface — visually distinct from all other cards to signal
 * AI-generated content at a glance. Uses warning semantic tokens so it
 * works in both light and dark modes without hard-coded colors.
 */
export const insightHighlightSectionClass = cn(
  "relative rounded-2xl border bg-warning/[0.04] text-card-foreground",
  "border-warning/25 dark:border-warning/20 dark:bg-warning/[0.06]",
);

/** Amber left rail — restored to make the section unmissable. */
export const insightHighlightAccentClass =
  "absolute left-0 top-0 h-full w-1 rounded-l-2xl bg-warning/70";

export const insightHighlightHeaderRowClass =
  "flex items-stretch gap-0 rounded-t-2xl";

export const insightHighlightTriggerClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-t-2xl px-3 py-2.5 text-left outline-none hover:bg-warning/[0.06] focus-visible:ring-2 focus-visible:ring-ring";

export const insightHighlightTitleClass =
  "text-sm font-medium text-foreground";

export const insightHighlightSubtitleClass =
  "mt-0.5 truncate text-xs text-muted-foreground";

export const insightHighlightBodyClass =
  "px-3 pb-3 pt-1 border-t border-warning/20 dark:border-warning/15 bg-warning/[0.03]";

export const insightHighlightNarrativeClass =
  "text-sm leading-relaxed text-foreground";
