import { useCallback, useState } from "react";
import {
  markHowSuitesWorkSeen,
  readHowSuitesWorkSeen,
  shouldShowHowSuitesWork,
  type HowSuitesWorkTrigger,
} from "./how-suites-work-model";

export interface HowSuitesWorkController {
  /** The trigger that opened the tutorial, or null while it is closed. */
  trigger: HowSuitesWorkTrigger | null;
  /** Opens the tutorial if the trigger rules allow it; returns whether it opened. */
  request: (trigger: HowSuitesWorkTrigger) => boolean;
  close: () => void;
}

/**
 * Owns when the tutorial is open. The host page calls `request("first_visit")`
 * on mount, `request("first_suite")` after creating its first suite, and
 * `request("menu")` from the ⋮ menu. Showing it marks it seen.
 */
export function useHowSuitesWork(): HowSuitesWorkController {
  const [trigger, setTrigger] = useState<HowSuitesWorkTrigger | null>(null);

  const request = useCallback(
    (next: HowSuitesWorkTrigger) => {
      if (trigger) return false;
      if (!shouldShowHowSuitesWork(next, readHowSuitesWorkSeen())) return false;
      markHowSuitesWorkSeen();
      setTrigger(next);
      return true;
    },
    [trigger],
  );

  const close = useCallback(() => setTrigger(null), []);

  return { trigger, request, close };
}
