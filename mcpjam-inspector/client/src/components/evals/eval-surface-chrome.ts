import { cn } from "@/lib/utils";

/** Flat eval card shell — single surface, hairline border, no gradient/ring/shadow. */
export const evalSurfaceCardClass = cn(
  "rounded-2xl border border-border/50 bg-card text-card-foreground",
  "dark:border-border/40",
);

/** Card header / column-header band — same surface as the body, divider only. */
export const evalSurfaceHeaderClass = cn(
  "border-b border-border/40",
  "dark:border-border/30",
);

/** Matrix / table body cells — transparent so they inherit card surface. */
export const evalSurfaceCellClass = "bg-transparent";

/** Row hover inside eval tables and lists. */
export const evalSurfaceRowHoverClass = cn(
  "transition-colors",
  "hover:bg-muted/70 focus-within:bg-muted/70",
  "dark:hover:bg-muted/45 dark:focus-within:bg-muted/45",
);
