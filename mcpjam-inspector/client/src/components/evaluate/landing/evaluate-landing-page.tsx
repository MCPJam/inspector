import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useAppRouteContext } from "@/lib/app-route-context";
import type { EvalRoute } from "@/lib/eval-route-types";
import { EvalTabGate } from "../../evals/EvalTabGate";
import { ProjectRunsTable } from "../../evals/project-runs-table";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";
import { EvalsEmptyHero } from "../evals-empty-hero";
import {
  EvaluateNavLandingHeader,
  type EvalLandingView,
} from "../evals-header";
import { useEvaluateTutorial } from "./evaluate-tutorial";
import { SuiteCard } from "./suite-card";
import { useEvaluateSuiteOverview } from "./use-evaluate-suite-overview";

/** `/evaluate` (Suites) and `/evaluate/runs` (Runs). */
export type EvaluateLandingRoute = Extract<
  EvalRoute,
  { type: "list" } | { type: "evaluate-runs" }
>;

const LANDING_ROUTES: Record<EvalLandingView, EvaluateLandingRoute> = {
  suites: { type: "list" },
  runs: { type: "evaluate-runs" },
};

const openCreateSuite = () => navigatePlaygroundEvalsRoute({ type: "create" });
const openSuite = (suiteId: string) =>
  navigatePlaygroundEvalsRoute({ type: "suite-overview", suiteId });
const openRun = ({ suiteId, runId }: { suiteId: string; runId: string }) =>
  navigatePlaygroundEvalsRoute({ type: "run-detail", suiteId, runId });
const openSuiteSettings = (suiteId: string) =>
  navigatePlaygroundEvalsRoute({
    type: "suite-settings",
    suiteId,
    tab: "settings",
  });

/**
 * Evaluate's landing with the nav rework on (C1, C14, D12): Suites and Runs
 * are addresses, each suite shows its recent health, and the tutorial opens
 * on the first visit and from the ⋮ menu (C2).
 */
export function EvaluateLandingPage({
  route,
}: {
  route: EvaluateLandingRoute;
}) {
  const { convexProjectId } = useAppRouteContext();
  const projectId: string | null = convexProjectId ?? null;
  const { isAuthenticated } = useConvexAuth();
  return (
    <ErrorBoundary key={`${projectId ?? "none"}:${String(isAuthenticated)}`}>
      <LandingContent
        view={route.type === "evaluate-runs" ? "runs" : "suites"}
        projectId={projectId}
      />
    </ErrorBoundary>
  );
}

function LandingContent({
  view,
  projectId,
}: {
  view: EvalLandingView;
  projectId: string | null;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const requestTutorial = useEvaluateTutorial();
  const { suites, isLoading: suitesLoading } =
    useEvaluateSuiteOverview(projectId);

  // Once per landing mount; switching tabs keeps the page mounted.
  const askedFirstVisit = useRef(false);
  useEffect(() => {
    if (!requestTutorial || askedFirstVisit.current) return;
    askedFirstVisit.current = true;
    requestTutorial("first_visit");
  }, [requestTutorial]);

  return (
    <EvalTabGate
      variant="playground"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      projectId={projectId}
      isDirectGuest={isDirectGuest}
      header={
        <EvaluateNavLandingHeader
          view={view}
          onViewChange={(next) =>
            navigatePlaygroundEvalsRoute(LANDING_ROUTES[next])
          }
          onCreateSuite={openCreateSuite}
          onTutorial={() => requestTutorial?.("menu")}
        />
      }
    >
      {suitesLoading ? (
        <LandingMessage>
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          Loading suites…
        </LandingMessage>
      ) : suites.length === 0 ? (
        // The sample suite needs today's quickstart runner, which lives in
        // EvaluateTab; the new landing offers Create suite only for now.
        <EvalsEmptyHero
          onCreateSuite={openCreateSuite}
          onQuickstart={openCreateSuite}
          isQuickstartRunning={false}
          showQuickstart={false}
        />
      ) : view === "runs" ? (
        projectId ? (
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            data-testid="evals-runs-landing"
          >
            <ProjectRunsTable
              evaluateLayout
              historyMetricsEnabled
              decisionSummaryEnabled
              projectId={projectId}
              onSelectRun={openRun}
            />
          </div>
        ) : (
          <LandingMessage>Select a project to see runs.</LandingMessage>
        )
      ) : (
        <ul
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-6 sm:px-6"
          data-testid="evals-suites-landing"
        >
          {suites.map((entry) => (
            <SuiteCard
              key={entry.suite._id}
              entry={entry}
              onOpenSuite={openSuite}
              onOpenRun={openRun}
              onOpenSettings={openSuiteSettings}
            />
          ))}
        </ul>
      )}
    </EvalTabGate>
  );
}

function LandingMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
