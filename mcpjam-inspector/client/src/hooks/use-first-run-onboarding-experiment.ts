import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { usePostHog } from "posthog-js/react";
import { useActorKey } from "@/hooks/use-actor-key";
import { isPostHogDisabled } from "@/lib/PosthogUtils";
import {
  getFeatureFlagsActorKey,
  subscribeFeatureFlagsActor,
} from "@/lib/server-feature-flags";
import {
  HOME_CHECKLIST_FLAG,
  normalizeHomeChecklistVariant,
} from "@/components/home/checklist/use-home-checklist-variant";

export const FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG =
  "first-run-onboarding-vs-checklist";

/** How long a new user waits for their own flag values before onboarding opens. */
export const FIRST_RUN_EXPERIMENT_WAIT_MS = 2_000;

/**
 * `onboarding` opens the first-run overlay (today's flow), `checklist` skips
 * it so the user lands on the Home setup checklist, and `pending` means the
 * user's flag values have not arrived yet.
 */
export type FirstRunOnboardingDecision = "pending" | "onboarding" | "checklist";

type FlagReader = {
  getFeatureFlag: (
    key: string,
    options?: { send_event?: boolean },
  ) => string | boolean | undefined;
};

/**
 * Reads the experiment arm for a user whose flag values are loaded. Only a
 * user who would see the Home checklist enters the experiment: skipping
 * onboarding for anyone else would leave them on a Home with no setup path.
 * Reading the experiment flag is what records the exposure, so it is read
 * last and only for those users.
 */
export function decideFirstRunOnboarding(
  flags: FlagReader,
): Exclude<FirstRunOnboardingDecision, "pending"> {
  const homeChecklist = normalizeHomeChecklistVariant(
    flags.getFeatureFlag(HOME_CHECKLIST_FLAG, { send_event: false }),
  );
  if (homeChecklist !== "treatment") return "onboarding";
  const arm = flags.getFeatureFlag(FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG);
  return arm === "test" ? "checklist" : "onboarding";
}

/**
 * The first-run onboarding experiment's decision for this visit, fixed once
 * made. `candidate` is true only for a user about to see first-run onboarding
 * for the first time, so nobody else is counted as exposed. A user whose flag
 * values never arrive gets onboarding, without an exposure.
 */
export function useFirstRunOnboardingExperiment(
  candidate: boolean,
): FirstRunOnboardingDecision {
  const posthog = usePostHog();
  const actorKey = useActorKey();
  const flagsActorKey = useSyncExternalStore(
    subscribeFeatureFlagsActor,
    getFeatureFlagsActorKey,
  );
  const [decision, setDecision] = useState<Exclude<
    FirstRunOnboardingDecision,
    "pending"
  > | null>(null);

  // A layout effect, so a decision that is already available lands before the
  // first paint and the overlay never appears a frame late.
  useLayoutEffect(() => {
    if (decision !== null || !candidate) return;
    if (isPostHogDisabled || !posthog) {
      setDecision("onboarding");
      return;
    }
    if (actorKey && flagsActorKey === actorKey) {
      setDecision(decideFirstRunOnboarding(posthog));
      return;
    }
    const timer = setTimeout(() => {
      setDecision((current) => current ?? "onboarding");
    }, FIRST_RUN_EXPERIMENT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [decision, candidate, posthog, actorKey, flagsActorKey]);

  return decision ?? "pending";
}
