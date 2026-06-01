import { cn } from "@/lib/utils";

/** Lifted eval card shell — rounded, gradient, inset ring, visible shadow. */
export const evalSurfaceCardClass = cn(
  "rounded-2xl border border-border bg-card text-card-foreground",
  "bg-gradient-to-b from-card via-card to-muted/35",
  "shadow-md ring-1 ring-inset ring-foreground/[0.08]",
  "dark:border-border/90 dark:from-card dark:via-card dark:to-muted/25",
  "dark:shadow-md dark:ring-foreground/[0.1]",
);

/** Card header / column-header band — reads as a control strip atop the surface. */
export const evalSurfaceHeaderClass = cn(
  "border-b border-border/80 bg-muted/60 backdrop-blur-sm",
  "dark:border-border/70 dark:bg-muted/50",
);

/** Matrix / table body cells sitting on the page background. */
export const evalSurfaceCellClass = "bg-muted/15 dark:bg-muted/20";

/** Row hover inside eval tables and lists. */
export const evalSurfaceRowHoverClass = cn(
  "transition-colors",
  "hover:bg-muted/70 focus-within:bg-muted/70",
  "dark:hover:bg-muted/45 dark:focus-within:bg-muted/45",
);
