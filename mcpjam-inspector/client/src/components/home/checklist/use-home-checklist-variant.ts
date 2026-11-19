import { useLockedFlagVariant } from "@/hooks/use-locked-flag-variant";

export const HOME_CHECKLIST_FLAG = "home-setup-checklist";

export type HomeChecklistVariant = "control" | "treatment";

/**
 * `treatment` for a multivariate rollout's treatment arm, and for a plain
 * boolean rollout (100%) that is on. Anything else is today's Home.
 */
export function normalizeHomeChecklistVariant(
  raw: string | boolean | undefined,
): HomeChecklistVariant {
  return raw === "treatment" || raw === true ? "treatment" : "control";
}

/**
 * The Home variant, fixed for the rest of the visit once flags load. Until
 * flags load, and when they never do, Home renders control.
 */
export function useHomeChecklistVariant(): HomeChecklistVariant {
  return (
    useLockedFlagVariant(HOME_CHECKLIST_FLAG, normalizeHomeChecklistVariant) ??
    "control"
  );
}
