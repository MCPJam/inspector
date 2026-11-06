import { useCallback, useEffect, useState } from "react";
import {
  hasSeenHowSuitesWork,
  markHowSuitesWorkSeen,
} from "./how-suites-work-seen";

/** What opened the tutorial: the first Evaluate visit, or the ⋮ menu. */
export type HowSuitesWorkTrigger = "first_visit" | "menu";

export interface HowSuitesWorkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: HowSuitesWorkTrigger;
}

/**
 * Open state for the "How suites work" tutorial. With `autoOpen` it opens once
 * per browser and writes the seen key as it opens, so a reload part-way
 * through does not show it again. `openFromMenu` always opens it.
 */
export function useHowSuitesWork({ autoOpen }: { autoOpen: boolean }): {
  openFromMenu: () => void;
  dialogProps: HowSuitesWorkDialogProps;
} {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HowSuitesWorkTrigger>("first_visit");

  useEffect(() => {
    // The key is read and written in the same pass, so StrictMode's second
    // run finds it set and does not open again.
    if (!autoOpen || hasSeenHowSuitesWork()) return;
    markHowSuitesWorkSeen();
    setTrigger("first_visit");
    setOpen(true);
  }, [autoOpen]);

  const openFromMenu = useCallback(() => {
    setTrigger("menu");
    setOpen(true);
  }, []);

  return {
    openFromMenu,
    dialogProps: { open, onOpenChange: setOpen, trigger },
  };
}
