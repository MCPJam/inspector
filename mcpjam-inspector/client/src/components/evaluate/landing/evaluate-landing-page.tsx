import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import type { EvalRoute } from "@/lib/eval-route-types";
import { ProjectRunsTable } from "../../evals/project-runs-table";
import type { EvalSuite } from "../../evals/types";
import { useEvalQueries } from "../../evals/use-eval-queries";
import { EvalNavLandingHeader, type EvalNavLandingTab } from "../evals-header";
import { EvalsEmptyHero } from "../evals-empty-hero";
import { HowSuitesWorkDialog, useHowSuitesWork } from "../how-suites-work";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavigate } from "../nav/eval-nav-state";
import { SuiteListRunReview } from "../suite-list-run-review";
import { resolveSuiteTargets } from "../suites-overview";
import { SuiteCards } from "./suite-cards";

const TAB_ROUTES: Record<EvalNavLandingTab, EvalRoute> = {
  suites: { type: "list" },
  runs: { type: "evaluate-runs" },
};

/**
 * The Evaluate landing with the flag on: Suites (/evaluate) and Runs
 * (/evaluate/runs). It loads its own data with the same hooks and arguments
 * as EvaluateTab, so Convex shares the subscriptions, and takes every action
 * from the page services.
 */
export function EvaluateLandingPage({ route, projectId }: EvalNavPageProps) {
  const { isAuthenticated } = useConvexAuth();
  const services = useEvalNavPageServices();
  const navigate = useEvalNavigate();
  const tab: EvalNavLandingTab =
    route.type === "evaluate-runs" ? "runs" : "suites";
  const { sortedSuites, isOverviewLoading } = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: null,
    deletingSuiteId: null,
    projectId,
    organizationId: null,
    isDirectGuest: services.isDirectGuest,
  });
  const { canDeleteArtifact } = useEvalTabContext({
    isAuthenticated,
    projectId,
    isDirectGuest: services.isDirectGuest,
  });
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const rows = useMemo(() => {
    const targets = resolveSuiteTargets(
      sortedSuites,
      environments ?? [],
      new Map(hosts.map((host) => [host.hostId, host.name])),
      new Map(hosts.map((host) => [host.hostId, host.modelId])),
    );
    return sortedSuites.map((entry) => ({
      entry,
      models: targets.get(entry.suite._id)?.models ?? [],
      clients: targets.get(entry.suite._id)?.clients ?? [],
    }));
  }, [sortedSuites, environments, hosts]);
  const [reviewSuiteId, setReviewSuiteId] = useState<string | null>(null);
  const reviewSuite = sortedSuites.find(
    (entry) => entry.suite._id === reviewSuiteId,
  )?.suite;
  const tutorial = useHowSuitesWork({ autoOpen: true });

  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });

  const from = { route, names: {} };
  const openRun = (target: { suiteId: string; runId: string }) =>
    navigate({ type: "run-detail", ...target }, { via: "link", from });
  const openSettings = (suiteId: string) =>
    navigate(
      { type: "suite-settings", suiteId, tab: "settings" },
      { via: "link", from },
    );
  const heroServers = services.projectServers.filter(
    (server) => server.name.trim().length > 0,
  );

  const hero = (
    <EvalsEmptyHero
      onCreateSuite={() => services.openCreateSuite()}
      onEvalServer={(server) =>
        services.openCreateSuite(
          heroServers.find((candidate) => candidate._id === server.id),
        )
      }
      onQuickstart={() => services.quickstart?.run()}
      isQuickstartRunning={services.quickstart?.running ?? false}
      showQuickstart={services.quickstart !== null}
      servers={heroServers.map((server) => ({
        id: server._id,
        name: server.name,
      }))}
      serversLoading={false}
    />
  );

  let body;
  if (isOverviewLoading) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading suites…</p>
        </div>
      </div>
    );
  } else if (sortedSuites.length === 0) {
    body = hero;
  } else if (tab === "runs") {
    body =
      projectId && shouldQueryProjectId(projectId) ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="evals-runs-landing"
        >
          <ProjectRunsTable
            evaluateLayout
            historyMetricsEnabled
            navLanding
            projectId={projectId}
            onDeleteRun={services.deleteRun}
            canDeleteRun={(run) => canDeleteArtifact(run.createdBy)}
            onSelectRun={openRun}
            decisionSummaryEnabled
            emptyState={hero}
          />
        </div>
      ) : null;
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <SuiteCards
          rows={rows}
          onOpenSuite={(suiteId) =>
            navigate({ type: "suite-overview", suiteId }, { via: "link", from })
          }
          onOpenRun={openRun}
          onOpenSettings={openSettings}
          onRunSuite={(suite: EvalSuite) => setReviewSuiteId(suite._id)}
          onCancelRun={(runIds) => void services.cancelRun(runIds)}
          rerunningSuiteId={services.rerunningSuiteId}
          cancellingRunId={services.cancellingRunId}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <EvalNavLandingHeader
        tab={tab}
        onTabChange={(next) => {
          if (next !== tab) navigate(TAB_ROUTES[next], { via: "link" });
        }}
        onCreateSuite={() => services.openCreateSuite()}
        onOpenTutorial={tutorial.openFromMenu}
      />
      {body}
      {reviewSuite ? (
        <SuiteListRunReview
          key={reviewSuite._id}
          projectId={projectId}
          suite={reviewSuite}
          onClose={() => setReviewSuiteId(null)}
          onStart={services.runSuite}
          onEditSettings={() => {
            setReviewSuiteId(null);
            openSettings(reviewSuite._id);
          }}
          disabledReason={services.evalRunsDisabledReason}
        />
      ) : null}
      <HowSuitesWorkDialog {...tutorial.dialogProps} />
    </div>
  );
}
