import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import type { TourStopId } from "./evaluate-tour-steps";

const STORAGE_KEY = "mcpjam-evaluate-tour-seen";
const LOCATION = "evaluate_tour";

/**
 * Whether this browser has already been shown the tour. Storage is a
 * per-viewer convenience: when it is blocked the answer is "seen", so a
 * private window is never nagged on every visit.
 */
export function hasSeenEvaluateTour(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage blocked: report seen so the tour does not auto-open every visit.
    return true;
  }
}

export function markEvaluateTourSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage blocked: the replay button still works; nothing to persist.
  }
}

/**
 * `intro` is the welcome modal over the real Evaluate page, `stage` the four
 * stops on example data, `handoff` the "Your turn" note on the real
 * create-suite form.
 */
export type EvaluateTourPhase = "closed" | "intro" | "stage" | "handoff";
export type EvaluateTourTrigger = "auto" | "replay";
/** How the "Your turn" note went away. */
export type EvaluateTourHandoffEnd =
  "got_it" | "clicked_away" | "escape" | "form_closed";

export type EvaluateTourController = {
  phase: EvaluateTourPhase;
  open: (trigger: EvaluateTourTrigger) => void;
  begin: () => void;
  viewStop: (stop: TourStopId, index: number) => void;
  skip: (at: TourStopId | "intro") => void;
  complete: () => void;
  dismissHandoff: (reason: EvaluateTourHandoffEnd) => void;
};

export function useEvaluateTour({
  autoOpenEligible,
  onComplete,
}: {
  /** True on the Evaluate landing when the project has no suites yet. */
  autoOpenEligible: boolean;
  /** Opens the real create-suite form the handoff note points at. */
  onComplete: () => void;
}): EvaluateTourController {
  const [phase, setPhase] = useState<EvaluateTourPhase>("closed");
  const autoOpenedRef = useRef(false);
  const openedAtRef = useRef(0);

  const open = useCallback((trigger: EvaluateTourTrigger) => {
    markEvaluateTourSeen();
    openedAtRef.current = Date.now();
    track("evaluate_tour_opened", { location: LOCATION, trigger });
    setPhase("intro");
  }, []);

  useEffect(() => {
    if (!autoOpenEligible || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (!hasSeenEvaluateTour()) open("auto");
  }, [autoOpenEligible, open]);

  const begin = useCallback(() => setPhase("stage"), []);

  const viewStop = useCallback((stop: TourStopId, index: number) => {
    track("evaluate_tour_step_viewed", {
      location: LOCATION,
      step: stop,
      step_index: index,
    });
  }, []);

  const skip = useCallback((at: TourStopId | "intro") => {
    track("evaluate_tour_skipped", {
      location: LOCATION,
      step: at,
      duration_ms: Date.now() - openedAtRef.current,
    });
    setPhase("closed");
  }, []);

  const complete = useCallback(() => {
    track("evaluate_tour_completed", {
      location: LOCATION,
      duration_ms: Date.now() - openedAtRef.current,
    });
    setPhase("handoff");
    onComplete();
  }, [onComplete]);

  const dismissHandoff = useCallback((reason: EvaluateTourHandoffEnd) => {
    track("evaluate_tour_handoff_ended", { location: LOCATION, reason });
    setPhase("closed");
  }, []);

  return { phase, open, begin, viewStop, skip, complete, dismissHandoff };
}
