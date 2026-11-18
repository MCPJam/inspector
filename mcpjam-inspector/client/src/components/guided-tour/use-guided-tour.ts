import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { useAnnouncementSlot } from "../announcement-slot";

/**
 * Whether this browser has already been shown the tour stored under `key`.
 * Storage is a per-viewer convenience: when it is blocked the answer is
 * "seen", so a private window is never nagged on every visit.
 */
export function hasSeenTour(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    // Storage blocked: report seen so the tour does not auto-open every visit.
    return true;
  }
}

export function markTourSeen(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: the replay button still works; nothing to persist.
  }
}

/**
 * `intro` is the welcome card over the real page, `stage` the stops on
 * example data, `handoff` the "Your turn" note on the real control.
 */
export type GuidedTourPhase = "closed" | "intro" | "stage" | "handoff";
export type GuidedTourTrigger = "auto" | "replay";
/** How the "Your turn" note went away. */
export type GuidedTourHandoffEnd =
  "got_it" | "clicked_away" | "escape" | "form_closed";

/** The analytics events one tour fires. Register each in `analytics-events`. */
export type GuidedTourEvents = {
  opened: ClientAnalyticsEventName;
  stepViewed: ClientAnalyticsEventName;
  skipped: ClientAnalyticsEventName;
  completed: ClientAnalyticsEventName;
  handoffEnded: ClientAnalyticsEventName;
};

export type GuidedTourConfig = {
  /** localStorage key; set when the tour first opens. */
  seenKey: string;
  /** The `location` on every event. */
  location: string;
  events: GuidedTourEvents;
  /** True where and when the tour may open by itself. */
  autoOpenEligible: boolean;
  /** Runs after the last stop, before the handoff note shows. */
  onComplete: () => void;
};

export type GuidedTourController<StopId extends string> = {
  phase: GuidedTourPhase;
  open: (trigger: GuidedTourTrigger) => void;
  begin: () => void;
  viewStop: (stop: StopId, index: number) => void;
  skip: (at: StopId | "intro") => void;
  complete: () => void;
  dismissHandoff: (reason: GuidedTourHandoffEnd) => void;
};

/**
 * A tour's lifecycle and funnel events. Auto-opens once per browser while
 * `autoOpenEligible`; `open("replay")` reopens it on demand.
 */
export function useGuidedTour<StopId extends string>({
  seenKey,
  location,
  events,
  autoOpenEligible,
  onComplete,
}: GuidedTourConfig): GuidedTourController<StopId> {
  const [phase, setPhase] = useState<GuidedTourPhase>("closed");
  const autoOpenedRef = useRef(false);
  const triggerRef = useRef<GuidedTourTrigger | null>(null);
  const openedAtRef = useRef(0);
  const { opened, stepViewed, skipped, completed, handoffEnded } = events;
  const canAutoOpen =
    autoOpenEligible && !autoOpenedRef.current && !hasSeenTour(seenKey);
  const { open: hasAnnouncementSlot } = useAnnouncementSlot(
    phase === "closed" ? canAutoOpen : triggerRef.current === "auto",
  );

  const open = useCallback(
    (trigger: GuidedTourTrigger) => {
      triggerRef.current = trigger;
      markTourSeen(seenKey);
      openedAtRef.current = Date.now();
      track(opened, { location, trigger });
      setPhase("intro");
    },
    [seenKey, location, opened],
  );

  useEffect(() => {
    if (phase !== "closed" || !canAutoOpen || !hasAnnouncementSlot) return;
    autoOpenedRef.current = true;
    open("auto");
  }, [phase, canAutoOpen, hasAnnouncementSlot, open]);

  const begin = useCallback(() => setPhase("stage"), []);

  const viewStop = useCallback(
    (stop: StopId, index: number) => {
      track(stepViewed, { location, step: stop, step_index: index });
    },
    [location, stepViewed],
  );

  const skip = useCallback(
    (at: StopId | "intro") => {
      track(skipped, {
        location,
        step: at,
        duration_ms: Date.now() - openedAtRef.current,
      });
      setPhase("closed");
    },
    [location, skipped],
  );

  const complete = useCallback(() => {
    track(completed, {
      location,
      duration_ms: Date.now() - openedAtRef.current,
    });
    setPhase("handoff");
    onComplete();
  }, [location, completed, onComplete]);

  const dismissHandoff = useCallback(
    (reason: GuidedTourHandoffEnd) => {
      track(handoffEnded, { location, reason });
      setPhase("closed");
    },
    [location, handoffEnded],
  );

  return { phase, open, begin, viewStop, skip, complete, dismissHandoff };
}
