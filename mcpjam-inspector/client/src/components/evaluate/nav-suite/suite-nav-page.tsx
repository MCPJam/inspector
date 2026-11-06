/**
 * The Suite page on the new pages (route kind suite-overview): the suite's
 * health and run history, read-only. It loads its own data through the hooks
 * EvaluateTab uses (same arguments, so Convex shares the subscriptions) and
 * takes every action that needs EvaluateTab's handlers from page services.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "sonner";
import { useHostList } from "@/hooks/useClients";
import { pickSuiteExportCases } from "@/lib/evals/eval-export";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { useSharedAppState } from "@/state/app-state-context";
import { EvalExportModal } from "@/components/evals/eval-export-modal";
import {
  buildHostNamesById,
  compareRunsBySequence,
  runClientIdentity,
} from "@/components/evals/helpers";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import type {
  EvalCase,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "@/components/evals/types";
import { useEvalQueries } from "@/components/evals/use-eval-queries";
import type { EvalExportCaseInput } from "@/lib/evals/eval-export";
import { EvalCrumbBar } from "../evals-header";
import { SuitePills } from "../landing/suite-pills";
import { buildEvalBack, buildEvalCrumbs } from "../nav/eval-nav-crumbs";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import { useEvalNavArrival, useEvalNavigate } from "../nav/eval-nav-state";
import { resolveSuitePassThreshold } from "../run-compare-lanes-model";
import { launchRuns } from "../run-results-matrix-model";
import { SuiteDetailOverview } from "../suite-detail-overview";
import type { SuiteDetailNav } from "./suite-page-header";

const NO_CASES: EvalCase[] = [];

const suiteRunQuery = makeFunctionReference<
  "query",
  { runId: string },
  EvalSuiteRun | null
>("testSuites:getTestSuiteRun");

/** Model and client of the newest launch, as the history's first row shows them. */
export function newestLaunchPills(
  runs: readonly EvalSuiteRunListItem[],
  hostNamesById: ReadonlyMap<string, string | null>,
): { models: (string | null)[]; clients: string[] } {
  const newest = [...runs].sort((a, b) => compareRunsBySequence(b, a))[0];
  if (!newest) return { models: [], clients: [] };
  const members = launchRuns(newest, runs);
  return {
    models: [...new Set(members.map((run) => run.effectiveModelId ?? null))],
    clients: [
      ...new Set(
        members.map((run) => runClientIdentity(run, hostNamesById).name),
      ),
    ],
  };
}

export function SuiteNavPage({ route, projectId }: EvalNavPageProps) {
  const suiteRoute = route.type === "suite-overview" ? route : null;
  if (!suiteRoute) return null;
  return <SuiteNavPageBody route={suiteRoute} projectId={projectId} />;
}

function SuiteNavPageBody({
  route,
  projectId,
}: {
  route: Extract<EvalNavPageProps["route"], { type: "suite-overview" }>;
  projectId: string | null;
}) {
  const services = useEvalNavPageServices();
  const { isAuthenticated } = useConvexAuth();
  const convex = useConvex();
  const appState = useSharedAppState();
  const navigate = useEvalNavigate();
  const { from } = useEvalNavArrival();
  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: route.suiteId,
    deletingSuiteId: null,
    projectId,
    organizationId: null,
    isDirectGuest: services.isDirectGuest,
    perRunMetrics: true,
  });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const suite = queries.selectedSuite;
  const cases = queries.suiteDetails?.testCases ?? NO_CASES;
  const runs = queries.runsForSelectedSuite;
  const hostNamesById = useMemo(
    () => buildHostNamesById(suite?.hostAttachments, hosts),
    [suite?.hostAttachments, hosts],
  );
  const names = useMemo(
    () => (suite ? { suiteName: stripTimestampSuffix(suite.name || "") } : {}),
    [suite],
  );
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });

  // A deleted suite, or one this reader cannot see, as EvaluateTab decides it.
  const gone =
    !queries.isOverviewLoading &&
    !queries.isSuiteDetailsLoading &&
    !queries.selectedSuiteEntry;
  useEffect(() => {
    if (gone) navigate({ type: "list" }, { via: "redirect", replace: true });
  }, [gone, navigate]);

  const [exportCases, setExportCases] = useState<EvalExportCaseInput[] | null>(
    null,
  );
  const openExport = useCallback(async () => {
    try {
      const latest = [...runs].sort((a, b) => compareRunsBySequence(b, a))[0];
      const full =
        cases.length === 0 && latest
          ? await convex.query(suiteRunQuery, { runId: latest._id })
          : null;
      setExportCases(pickSuiteExportCases(cases, full ? [full] : []));
    } catch {
      toast.error("Could not load suite export");
    }
  }, [cases, runs, convex]);

  const forwardImportJob = useCallback(
    (importJob: string) =>
      navigate(
        {
          type: "suite-settings",
          suiteId: route.suiteId,
          tab: "cases",
          importJob,
        },
        { via: "redirect", replace: true },
      ),
    [navigate, route.suiteId],
  );

  // `?importJob=` is Suite settings' now: hand it on before showing anything.
  useEffect(() => {
    if (route.importJob) forwardImportJob(route.importJob);
  }, [route.importJob, forwardImportJob]);

  const nav = useMemo<SuiteDetailNav | null>(() => {
    if (!suite) return null;
    const leaving = { via: "link" as const, from: { route, names } };
    const pills = newestLaunchPills(runs, hostNamesById);
    const threshold = resolveSuitePassThreshold(suite);
    return {
      onOpenRun: (runId) =>
        navigate(
          { type: "run-detail", suiteId: route.suiteId, runId },
          leaving,
        ),
      ...(services.isDirectGuest
        ? {}
        : {
            onOpenSettings: () =>
              navigate(
                {
                  type: "suite-settings",
                  suiteId: route.suiteId,
                  tab: "settings",
                },
                leaving,
              ),
          }),
      onBuildCase: () =>
        navigate({ type: "case-new", suiteId: route.suiteId }, leaving),
      onForwardImportJob: forwardImportJob,
      pills: <SuitePills models={pills.models} clients={pills.clients} />,
      threshold: threshold == null ? null : Math.round(threshold * 100),
    };
  }, [
    suite,
    route,
    names,
    runs,
    hostNamesById,
    navigate,
    services.isDirectGuest,
    forwardImportJob,
  ]);

  if (route.importJob) return null;
  const review = suite ? services.launchReview(suite) : null;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="nav-suite-page"
    >
      <EvalCrumbBar
        crumbs={buildEvalCrumbs(route, names) ?? []}
        back={buildEvalBack(route, names, from)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6">
        {!suite || !nav ? (
          <p
            className="py-10 text-center text-sm text-muted-foreground"
            role="status"
          >
            Loading suite…
          </p>
        ) : (
          <SuiteDetailOverview
            nav={nav}
            suite={suite}
            cases={cases}
            runs={runs}
            runsLoading={
              queries.isSuiteRunsLoading || queries.isRunMetricsLoading
            }
            runHistoryStatus={queries.runHistoryStatus}
            onLoadMoreRuns={queries.loadMoreRuns}
            metricsByRun={queries.metricsByRun}
            hostNamesById={hostNamesById}
            environments={review?.environments}
            onRerun={services.runSuite}
            onEditSuite={nav.onOpenSettings ?? (() => undefined)}
            onSetupSdk={() => void openExport()}
            onDuplicateSuite={() => services.duplicateSuite(suite)}
            onRunClick={nav.onOpenRun}
            onTestCaseClick={(testCaseId) =>
              navigate(
                { type: "case-settings", suiteId: route.suiteId, testCaseId },
                { via: "link", from: { route, names } },
              )
            }
            onDeleteRun={services.deleteRun}
            canDeleteRun={services.canDeleteRun}
            onCancelRun={(runIds) => void services.cancelRun(runIds)}
            cancellingRunId={services.cancellingRunId}
            rerunningSuiteId={services.rerunningSuiteId}
            replayingRunId={services.replayingRunId}
            runningTestCaseId={services.runningTestCaseId}
            evalRunsDisabledReason={services.evalRunsDisabledReason}
            readOnlyConfig={services.isDirectGuest}
            configLocked={isCiOwnedSuite(suite)}
            projectId={projectId}
            importJobId={route.importJob ?? null}
          />
        )}
      </div>
      {suite ? (
        <EvalExportModal
          open={exportCases !== null}
          onOpenChange={(open) => {
            if (!open) setExportCases(null);
          }}
          scope="suite"
          projectId={projectId}
          suite={suite}
          cases={exportCases ?? []}
          serverEntries={appState.servers}
        />
      ) : null}
    </div>
  );
}
