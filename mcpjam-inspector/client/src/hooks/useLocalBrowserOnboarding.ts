import { useCallback, useState, useSyncExternalStore } from "react";
import {
  localBrowserOnboardingDecision,
  rememberLocalBrowserOnboarding,
  subscribeLocalBrowserConsent,
} from "@/lib/local-browser-consent";

/** Discovery is remembered separately from the device's permission capability. */
export function useLocalBrowserOnboarding() {
  const decision = useSyncExternalStore(
    subscribeLocalBrowserConsent,
    localBrowserOnboardingDecision,
    () => null,
  );
  // Storage can be blocked: dismissal should still work for this mount.
  const [dismissedHere, setDismissedHere] = useState(false);
  const dismiss = useCallback(() => {
    setDismissedHere(true);
    rememberLocalBrowserOnboarding("dismissed");
  }, []);
  return { undecided: !decision && !dismissedHere, dismiss };
}
