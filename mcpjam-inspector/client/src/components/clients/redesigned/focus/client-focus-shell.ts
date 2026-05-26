import { cn } from "@/lib/utils";

/** Root chrome for the docked host focus panel — follows global theme. */
export const hostFocusShellRootClass = cn(
  "flex h-full min-h-0 flex-col overflow-hidden",
  "border-l border-border bg-background text-foreground",
);

/** Scroll region for focus panel / dialog body. */
export const hostFocusShellScrollClass = cn(
  "min-h-0 flex-1 overflow-y-auto px-5 py-4",
);

export const hostFocusShellHeaderRowClass = cn(
  "flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-sm",
);

/** Modal shell — matches app background and border tokens. */
export const hostFocusShellDialogChromeClass = cn(
  "border border-border bg-background text-foreground shadow-lg",
);
