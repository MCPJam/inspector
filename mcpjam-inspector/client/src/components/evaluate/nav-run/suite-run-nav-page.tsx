/**
 * The Suite run page on the new pages (route kind run-detail): one suite
 * run's report. It loads the run, its launch, the run before it and their
 * iterations through the hooks SuiteIterationsView uses, and takes Run again
 * and Cancel from page services.
 */
import { useEffect, useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useHostList } from "@/hooks/useClients";
import { buildHostNamesById } from "@/components/evals/helpers";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import type { EvalCase, EvalSuiteRunListItem } from "@/components/evals/types";
import { useEvalQueries } from "@/components/evals/use-eval-queries";
import { useRunGroupSummaries } from "@/components/evals/use-run-group-summaries";
import {
  runPageRunIds,
  useRunsIterations,
} from "@/components/evals/use-runs-iterations";
import { useRunDetailData } from "@/components/evals/use-suite-data";
import { useSelectedRun } from "@/components/evals/use-selected-run";
import { EvalCrumbBar } from "../evals-header";
import { EvaluateRunContent } from "../evaluate-run-content";
import { summarizeRunChanges } from "../evaluate-run-diff-model";
import { EvaluateRunPage } from "../evaluate-run-page";
import { buildEvalBack, buildEvalCrumbs } from "../nav/eval-nav-crumbs";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import { useEvalNavArrival, useEvalNavigate } from "../nav/eval-nav-state";
import { resolveSuitePassThreshold } from "../run-compare-lanes-model";
import { useEvalRunCompare } from "../use-eval-run-compare";
import {
  compareCandidates,
  compareTease,
  previousRunForRunPage,
} from "./run-page-data";
import { useNavRunLinks } from "./use-nav-run-links";

type RunRoute = Extract<EvalNavPageProps["route"], { type: "run-detail" }>;

const NO_CASES: EvalCase[] = [];

function RunPageStatus({ label, busy }: { label: string; busy: boolean }) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-8"
      data-testid="suite-rows-loading"
      role="status"
    >
      <div className="text-center">
        {busy ? (
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
        ) : null}
        <p
          className={
            busy
              ? "mt-3 text-sm text-muted-foreground"
              : "text-sm text-muted-foreground"
          }
        >
          {label}
        </p>
      </div>
    </div>
  );
}

export function SuiteRunNavPage({ route, projectId }: EvalNavPageProps) {
  if (route.type !== "run-detail") return null;
  return <SuiteRunNavPageBody route={route} projectId={projectId} />;
}

function SuiteRunNavPageBody({
  route,
  projectId,
}: {
  route: RunRoute;
  projectId: string | null;
}) {
  const services = useEvalNavPageServices();
  const { isAuthenticated } = useConvexAuth();
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
  const selected = useSelectedRun(route.suiteId, route.runId);
  const run = selected.run;
  const { runs: groupRuns, loadGroup } = useRunGroupSummaries(
    route.suiteId,
    queries.runsForSelectedSuite,
  );
  const runs = useMemo<EvalSuiteRunListItem[]>(
    () =>
      run
        ? [run, ...groupRuns.filter((item) => item._id !== run._id)]
        : groupRuns,
    [run, groupRuns],
  );
  useEffect(() => {
    if (run?.runGroupId)
      void loadGroup(run.runGroupId).catch(() =>
        toast.error("Could not load the complete run group. Try again."),
      );
  }, [loadGroup, run?._id, run?.runGroupId]);
  const previous = useMemo(() => previousRunForRunPage(run, runs), [run, runs]);
  const rowRunIds = useMemo(
    () => (run ? runPageRunIds(run, runs, previous?._id ?? null) : []),
    [run, runs, previous],
  );
  const rows = useRunsIterations(rowRunIds);
  const { caseGroupsForSelectedRun } = useRunDetailData(
    route.runId,
    rows.iterations,
    "result",
  );
  const hostNamesById = useMemo(
    () => buildHostNamesById(suite?.hostAttachments, hosts),
    [suite?.hostAttachments, hosts],
  );
  const names = useMemo(
    () => ({
      ...(suite ? { suiteName: stripTimestampSuffix(suite.name || "") } : {}),
      ...(run?.runNumber != null ? { runNumber: run.runNumber } : {}),
    }),
    [suite, run?.runNumber],
  );
  const links = useNavRunLinks(route, names, projectId);
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });
  const compare = useEvalRunCompare({
    projectId,
    run,
    ...(previous ? { baseRunId: previous._id } : {}),
    enabled: Boolean(projectId),
  });
  const changeTease = useMemo(
    () => compareTease(compare.dto ? summarizeRunChanges(compare.dto) : null),
    [compare.dto],
  );

  const gone =
    !queries.isOverviewLoading &&
    !queries.isSuiteDetailsLoading &&
    !queries.selectedSuiteEntry;
  useEffect(() => {
    if (gone) navigate({ type: "list" }, { via: "redirect", replace: true });
  }, [gone, navigate]);

  const leaving = { via: "link" as const, from: { route, names } };
  const thisRun = {
    type: "run-detail",
    suiteId: route.suiteId,
    runId: route.runId,
  } as const;
  const rowsPending =
    run != null && !rows.byRun.has(run._id) && !rows.failedRunIds.has(run._id);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="nav-run-page"
    >
      <EvalCrumbBar
        crumbs={buildEvalCrumbs(route, names) ?? []}
        back={buildEvalBack(route, names, from)}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-6">
        {selected.isUnavailable ? (
          <RunPageStatus
            label="This run is not in this suite's history. Check the link, or open the suite to see its runs."
            busy={false}
          />
        ) : !run || !suite || rowsPending ? (
          <RunPageStatus label="Loading run…" busy />
        ) : (
          <EvaluateRunPage
            suiteName={suite.name}
            nav={{
              suiteName: names.suiteName ?? suite.name,
              onOpenSettings: () =>
                navigate(
                  {
                    type: "suite-settings",
                    suiteId: route.suiteId,
                    tab: "settings",
                  },
                  leaving,
                ),
              changeTease,
            }}
            onOpenComparison={() =>
              navigate({ ...thisRun, comparison: true }, leaving)
            }
            onCompareWithRun={(baseRunId) =>
              navigate({ ...thisRun, compareToRunId: baseRunId }, leaving)
            }
            relatedRuns={runs}
            launchReview={{
              ...services.launchReview(suite),
              cases,
              onStart: services.runSuite,
            }}
            run={run}
            onCancelRun={(runIds) => void services.cancelRun(runIds)}
            cancellingRunId={services.cancellingRunId}
            hostNamesById={hostNamesById}
            iterations={rows.iterations}
            otherRuns={compareCandidates(run, runs)}
            defaultCompareRunId={previous?._id ?? null}
          >
            {projectId ? (
              <EvaluateRunContent
                projectId={projectId}
                suiteName={suite.name}
                run={run}
                iterations={caseGroupsForSelectedRun}
                allIterations={rows.iterations}
                siblingRuns={runs}
                hostNamesById={hostNamesById}
                previousRunId={previous?._id ?? null}
                decisionSummaryEnabled
                nav={{
                  ...links,
                  passThreshold: resolveSuitePassThreshold(suite),
                }}
              />
            ) : null}
          </EvaluateRunPage>
        )}
      </div>
    </div>
  );
}
