import {
  useGuidedTour,
  type GuidedTourController,
  type GuidedTourEvents,
} from "@/components/guided-tour/use-guided-tour";
import type { TourStopId } from "./evaluate-tour-steps";

const STORAGE_KEY = "mcpjam-evaluate-tour-seen";

const EVENTS: GuidedTourEvents = {
  opened: "evaluate_tour_opened",
  stepViewed: "evaluate_tour_step_viewed",
  skipped: "evaluate_tour_skipped",
  completed: "evaluate_tour_completed",
  handoffEnded: "evaluate_tour_handoff_ended",
};

export type EvaluateTourController = GuidedTourController<TourStopId>;

export function useEvaluateTour({
  autoOpenEligible,
  onComplete,
}: {
  /** True on the Evaluate landing when the project has no suites yet. */
  autoOpenEligible: boolean;
  /** Opens the real create-suite form the handoff note points at. */
  onComplete: () => void;
}): EvaluateTourController {
  return useGuidedTour<TourStopId>({
    seenKey: STORAGE_KEY,
    location: "evaluate_tour",
    events: EVENTS,
    autoOpenEligible,
    onComplete,
  });
}
