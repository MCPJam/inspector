import { useCallback, useState } from "react";
import { hasSeenHowSuitesWork, markHowSuitesWorkSeen } from "./seen-key";
import {
  autoOpenTrigger,
  type TutorialAutoEvent,
  type TutorialTrigger,
} from "./trigger-rules";

export interface HowSuitesWorkState {
  open: boolean;
  trigger: TutorialTrigger;
  setOpen: (open: boolean) => void;
  /** Always opens, whether or not the tutorial was seen. */
  openFromMenu: () => void;
  /** Call when Evaluate's Suites view mounts. */
  notifyEvaluateVisit: () => void;
  /** Call right after a suite is created. */
  notifySuiteCreated: () => void;
}

/** Open state and trigger rules for the How suites work dialog. */
export function useHowSuitesWork({
  enabled,
}: {
  enabled: boolean;
}): HowSuitesWorkState {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<TutorialTrigger>("menu");

  const show = useCallback((next: TutorialTrigger) => {
    // Marked when it opens, not when it finishes, so a reload mid-tutorial
    // does not show it again.
    markHowSuitesWorkSeen();
    setTrigger(next);
    setOpen(true);
  }, []);

  const notify = useCallback(
    (event: TutorialAutoEvent) => {
      const next = autoOpenTrigger(event, {
        enabled,
        seen: hasSeenHowSuitesWork(),
      });
      if (next) show(next);
    },
    [enabled, show],
  );

  const openFromMenu = useCallback(() => show("menu"), [show]);
  const notifyEvaluateVisit = useCallback(
    () => notify("evaluate_visit"),
    [notify],
  );
  const notifySuiteCreated = useCallback(
    () => notify("suite_created"),
    [notify],
  );

  return {
    open,
    trigger,
    setOpen,
    openFromMenu,
    notifyEvaluateVisit,
    notifySuiteCreated,
  };
}
