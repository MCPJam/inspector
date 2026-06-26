import type { CompatVerdict } from "@/lib/host-compat/types";

/**
 * Verdict styling shared across the compat surfaces (single-server report rows
 * and the multi-server matrix): a colored dot + colored label, no pill — keeps
 * each verdict to a single quiet visual.
 */
export const VERDICT_META: Record<
  CompatVerdict,
  { label: string; dot: string; text: string }
> = {
  works: {
    label: "Works",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};
