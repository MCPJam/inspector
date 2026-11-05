import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { track } from "@/lib/analytics";
import type { EvalRoute } from "@/lib/eval-route-types";
import { navigatePlaygroundEvalsRoute } from "./create-suite-navigation";
import type { EvalLandingView } from "./evals-header";
import { HowSuitesWorkDialog } from "./how-suites-work/how-suites-work-dialog";
import { useHowSuitesWork } from "./how-suites-work/use-how-suites-work";
import { useEvalNavPageViewed } from "./nav/eval-nav-link";
import { ConnectedSuiteCards } from "./suite-cards";

export function landingViewOf(route: EvalRoute): EvalLandingView | null {
  if (route.type === "list") return "suites";
  if (route.type === "evaluate-runs") return "runs";
  return null;
}

export interface EvaluateLandingNav {
  /** `EvalsHeader` props for the landing; empty off the landing. */
  header: {
    landingView?: EvalLandingView;
    onLandingViewChange?: (view: EvalLandingView) => void;
    onOpenTutorial?: () => void;
  };
  /** The tutorial dialog; mount it once, on every Evaluate page. */
  tutorial: ReactNode;
  /** The Suites tab's list: suite cards in place of today's table. */
  SuiteCards: typeof ConnectedSuiteCards;
}

/**
 * Evaluate's landing with the evaluate-nav flag on: Suites and Runs as
 * addresses, the How suites work tutorial (first visit, first suite, and the
 * ⋮ menu) and the landing's page-view event. Null while the flag is off or
 * loading, so callers keep today's landing.
 */
export function useEvaluateLandingNav({
  enabled,
  addressRoute,
  suiteCount,
}: {
  enabled: boolean | undefined;
  addressRoute: EvalRoute;
  /** The project's suites; null while they load. */
  suiteCount: number | null;
}): EvaluateLandingNav | null {
  const tutorial = useHowSuitesWork();
  const { openAutomatically, openFromMenu } = tutorial;
  const on = enabled === true;
  const landingView = on ? landingViewOf(addressRoute) : null;

  useEvalNavPageViewed(landingView ?? "suites", landingView !== null);

  // The first visit opens it even before the project has a suite.
  const onLanding = landingView !== null;
  useEffect(() => {
    if (onLanding) openAutomatically("first_visit");
  }, [onLanding, openAutomatically]);

  // First suite: the project goes from none to one while Evaluate is open.
  const previousCount = useRef<number | null>(null);
  useEffect(() => {
    if (suiteCount === null) return;
    const before = previousCount.current;
    previousCount.current = suiteCount;
    if (on && before === 0 && suiteCount > 0) openAutomatically("first_suite");
  }, [on, suiteCount, openAutomatically]);

  const onLandingViewChange = useCallback((view: EvalLandingView) => {
    navigatePlaygroundEvalsRoute(
      view === "runs" ? { type: "evaluate-runs" } : { type: "list" },
    );
  }, []);
  if (!on) return null;
  return {
    header: landingView
      ? { landingView, onLandingViewChange, onOpenTutorial: openFromMenu }
      : {},
    tutorial: (
      <HowSuitesWorkDialog
        open={tutorial.open}
        onOpenChange={tutorial.onOpenChange}
        trigger={tutorial.trigger}
        onEvent={(event, props) =>
          track(event, { location: "evaluate", ...props })
        }
      />
    ),
    SuiteCards: ConnectedSuiteCards,
  };
}
