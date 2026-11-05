import { useCallback, useState } from "react";
import {
  hasSeenHowSuitesWork,
  markHowSuitesWorkSeen,
  type HowSuitesWorkAutoTrigger,
  type HowSuitesWorkTrigger,
} from "./how-suites-work-model";

export interface HowSuitesWorkController {
  open: boolean;
  trigger: HowSuitesWorkTrigger;
  onOpenChange: (open: boolean) => void;
  /** The ⋮ menu's Tutorial item: opens every time. */
  openFromMenu: () => void;
  /**
   * Call on the first visit to Evaluate and after the first suite is created.
   * Opens only if this browser has not seen the tutorial, and marks it seen
   * so neither trigger opens it again. Returns whether it opened.
   */
  openAutomatically: (trigger: HowSuitesWorkAutoTrigger) => boolean;
}

export function useHowSuitesWork(): HowSuitesWorkController {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HowSuitesWorkTrigger>("menu");

  const openFromMenu = useCallback(() => {
    setTrigger("menu");
    setOpen(true);
  }, []);

  const openAutomatically = useCallback((next: HowSuitesWorkAutoTrigger) => {
    if (hasSeenHowSuitesWork()) return false;
    markHowSuitesWorkSeen();
    setTrigger(next);
    setOpen(true);
    return true;
  }, []);

  return {
    open,
    trigger,
    onOpenChange: setOpen,
    openFromMenu,
    openAutomatically,
  };
}
