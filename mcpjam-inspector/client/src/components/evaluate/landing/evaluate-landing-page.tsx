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
import { LaunchedCaseJudge } from "../case-scorecard/launched-case-judge";
import { openCreateSuite } from "../create-suite-prefill-store";
import { EvalsEmptyHero, openCreateSuiteForServer } from "../evals-empty-hero";
import {
  EvaluateNavLandingHeader,
  type EvalLandingView,
} from "../evals-header";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";
import { useEvaluateTutorial } from "./evaluate-tutorial";
import { SuiteList } from "./suite-list";
import { useEvaluateLandingActions } from "./use-evaluate-landing-actions";
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

const openBlankCreateSuite = () => openCreateSuite();

/** The landing's links; a run opened here makes this tab its Back target. */
function useLandingLinks(view: EvalLandingView) {
  const navigate = useEvaluateNavNavigate();
  return {
    openView: (next: EvalLandingView) => navigate(LANDING_ROUTES[next], "link"),
    openSuite: (suiteId: string) =>
      navigate({ type: "suite-overview", suiteId }, "link"),
    openRun: ({ suiteId, runId }: { suiteId: string; runId: string }) =>
      navigate({ type: "run-detail", suiteId, runId }, "link", {
        backPlace: view,
      }),
    openSuiteSettings: (suiteId: string) =>
      navigate({ type: "suite-settings", suiteId, tab: "settings" }, "link"),
  };
}

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
  const actions = useEvaluateLandingActions(projectId, suites);
  const links = useLandingLinks(view);

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
          onViewChange={links.openView}
          onCreateSuite={openBlankCreateSuite}
          onTutorial={() => requestTutorial?.("menu")}
        />
      }
    >
      {actions.run.judgeRunIds.map((runId) => (
        <LaunchedCaseJudge key={runId} runId={runId} />
      ))}
      {suitesLoading ? (
        <LandingMessage>
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          Loading suites…
        </LandingMessage>
      ) : suites.length === 0 ? (
        <EvalsEmptyHero
          onCreateSuite={openBlankCreateSuite}
          onEvalServer={openCreateSuiteForServer}
          onQuickstart={() => void actions.quickstart.run()}
          isQuickstartRunning={actions.quickstart.isRunning}
          showQuickstart={actions.quickstart.available}
          servers={actions.heroServers}
          serversLoading={actions.serversLoading}
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
              onSelectRun={links.openRun}
              onDeleteRun={actions.deleteRun}
              canDeleteRun={(run) => actions.canDeleteArtifact(run.createdBy)}
            />
          </div>
        ) : (
          <LandingMessage>Select a project to see runs.</LandingMessage>
        )
      ) : (
        <SuiteList
          projectId={projectId}
          suites={suites}
          run={actions.run}
          rerunningSuiteId={actions.rerunningSuiteId}
          onOpenSuite={links.openSuite}
          onOpenRun={links.openRun}
          onOpenSettings={links.openSuiteSettings}
        />
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
