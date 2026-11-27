import { useFeatureFlagVariantKey } from "posthog-js/react";
import { useLockedFlagVariant } from "@/hooks/use-locked-flag-variant";

export const HOME_CHECKLIST_FLAG = "home-setup-checklist";

export type HomeChecklistVariant = "control" | "treatment";

/** `treatment` for the treatment arm or a boolean flag that is on; else control. */
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
  const raw = useFeatureFlagVariantKey(HOME_CHECKLIST_FLAG);
  return useLockedFlagVariant(raw, normalizeHomeChecklistVariant) ?? "control";
}
