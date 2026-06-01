import { cn } from "@/lib/utils";

/** Shared visual treatment for AI insight surfaces (matches AiTriageCard). */
export const insightHighlightSectionClass = cn(
  "relative rounded-xl border text-card-foreground shadow-sm",
  "border-primary/20 bg-gradient-to-br from-primary/[0.07] via-card to-card",
  "ring-1 ring-inset ring-primary/10",
);

export const insightHighlightAccentClass =
  "pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-l-xl bg-primary/50";

export const insightHighlightHeaderRowClass =
  "flex items-stretch gap-0 rounded-t-xl border-b border-primary/10 bg-primary/[0.04]";

export const insightHighlightTriggerClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-t-xl px-3 py-2.5 pl-3.5 text-left outline-none hover:bg-primary/[0.06] focus-visible:ring-2 focus-visible:ring-ring";

export const insightHighlightTitleClass =
  "text-base font-semibold tracking-tight text-foreground";

export const insightHighlightSubtitleClass =
  "mt-0.5 truncate text-xs text-muted-foreground";

export const insightHighlightBodyClass = "px-3 py-3 pl-3.5";

export const insightHighlightNarrativeClass =
  "text-sm leading-relaxed text-foreground";
