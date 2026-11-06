import { useMemo } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference, type PaginationResult } from "convex/server";
import { isTerminalEvalRunStatus } from "@/lib/evals/eval-decision-summary-store";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { buildHostNamesById } from "../../evals/helpers";
import { useSelectedRun } from "../../evals/use-selected-run";
import { useRunsIterations } from "../../evals/use-runs-iterations";
import {
  buildRunResultsMatrix,
  launchRuns as launchOf,
  matrixCaseKey,
  type RunResultsMatrixData,
} from "../run-results-matrix-model";

/** Iterations read per launch run; a longer test run says it was cut. */
export const TEST_RUN_ITERATION_LIMIT = 200;
const FIRST_PAGE = { numItems: 20, cursor: null };

const suiteQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalSuite | null
>("testSuites:getTestSuite");
const caseQuery = makeFunctionReference<
  "query",
  { testCaseId: string },
  EvalCase | null
>("testSuites:getTestCase");
const runQuery = makeFunctionReference<
  "query",
  { runId: string },
  EvalSuiteRun | null
>("testSuites:getTestSuiteRun");
const runSummariesQuery = makeFunctionReference<
  "query",
  {
    suiteId: string;
    runGroupId: string;
    paginationOpts: { numItems: number; cursor: string | null };
  },
  PaginationResult<EvalSuiteRunListItem>
>("testSuites:listTestSuiteRunSummaries");
const caseIterationsQuery = makeFunctionReference<
  "query",
  {
    suiteRunId: string;
    testCaseId: string;
    paginationOpts: { numItems: number; cursor: string | null };
  },
  PaginationResult<EvalIteration>
>("testSuites:listTestRunIterations");

export type TestRunIds = { suiteId: string; runId: string; testCaseId: string };

export type TestRunData = {
  status: "loading" | "ready" | "runNotFound" | "caseNotInRun";
  suite: EvalSuite | null;
  /** The address's run. */
  run: EvalSuiteRun | null;
  /** The run and its same-launch siblings, each read whole. */
  launchRuns: EvalSuiteRun[];
  /** This case, every launch run. */
  iterations: EvalIteration[];
  /** Which read answered: the per-case read, or the run-wide one for legacy rows. */
  source: "case" | "runWide";
  /** A per-run page came back with more to read. */
  truncated: boolean;
  /** The current definition; null when deleted or unreadable. */
  testCase: EvalCase | null;
  title: string;
  matrix: RunResultsMatrixData | null;
};

type Answer<T> = T | null | Error | undefined;
const value = <T>(answer: Answer<T>): T | null =>
  answer instanceof Error ? null : (answer ?? null);

/** The ids of a launch: a run started on several models is one run per model. */
function useLaunchRuns(run: EvalSuiteRun | null) {
  const groupId = run?.runGroupId;
  const suiteId = run?.suiteId;
  const summaries = useQueries(
    useMemo<Parameters<typeof useQueries>[0]>(() => {
      const request: Parameters<typeof useQueries>[0] = {};
      if (suiteId && groupId) {
        request.page = {
          query: runSummariesQuery,
          args: { suiteId, runGroupId: groupId, paginationOpts: FIRST_PAGE },
        };
      }
      return request;
    }, [suiteId, groupId]),
  ).page as Answer<PaginationResult<EvalSuiteRunListItem>>;
  const siblingIds = useMemo(
    () =>
      run
        ? launchOf<EvalSuiteRunListItem>(run, value(summaries)?.page ?? [])
            .map((item) => item._id)
            .filter((id) => id !== run._id)
        : [],
    [run, summaries],
  );
  const siblingKey = siblingIds.join(",");
  const siblings = useQueries(
    useMemo<Parameters<typeof useQueries>[0]>(() => {
      const request: Parameters<typeof useQueries>[0] = {};
      for (const runId of siblingKey ? siblingKey.split(",") : []) {
        request[runId] = { query: runQuery, args: { runId } };
      }
      return request;
    }, [siblingKey]),
  );
  return useMemo(() => {
    if (!run) return { runs: [], loading: false };
    const loading =
      (Boolean(groupId) && summaries === undefined) ||
      siblingIds.some((id) => siblings[id] === undefined);
    const read = siblingIds.flatMap((id) => {
      const sibling = value(siblings[id] as Answer<EvalSuiteRun>);
      return sibling && sibling.suiteId === run.suiteId ? [sibling] : [];
    });
    return { runs: launchOf<EvalSuiteRun>(run, read), loading };
  }, [run, groupId, summaries, siblingIds, siblings]);
}

/**
 * One test run: one case inside one run, across the launch's models. Each
 * launch run is read for this case alone; a run whose rows predate the case
 * index (a key that is not a case id, or an empty page on a finished run)
 * falls back to that run's whole read, filtered to the case.
 */
export function useTestRunData(ids: TestRunIds): TestRunData {
  const { suiteId, runId, testCaseId } = ids;
  const selected = useSelectedRun(suiteId, runId);
  const run = selected.run;
  const launch = useLaunchRuns(run);
  const launchKey = launch.runs.map((item) => item._id).join(",");

  const reads = useQueries(
    useMemo<Parameters<typeof useQueries>[0]>(() => {
      const request: Parameters<typeof useQueries>[0] = {
        suite: { query: suiteQuery, args: { suiteId } },
        testCase: { query: caseQuery, args: { testCaseId } },
      };
      for (const id of launchKey ? launchKey.split(",") : []) {
        request[`run:${id}`] = {
          query: caseIterationsQuery,
          args: {
            suiteRunId: id,
            testCaseId,
            paginationOpts: {
              numItems: TEST_RUN_ITERATION_LIMIT,
              cursor: null,
            },
          },
        };
      }
      return request;
    }, [suiteId, testCaseId, launchKey]),
  );

  const perRun = useMemo(
    () =>
      launch.runs.map((item) => ({
        run: item,
        answer: reads[`run:${item._id}`] as Answer<
          PaginationResult<EvalIteration>
        >,
      })),
    [launch.runs, reads],
  );
  const fallbackIds = useMemo(
    () =>
      perRun
        .filter(
          ({ run: item, answer }) =>
            answer instanceof Error ||
            (answer &&
              answer.isDone &&
              answer.page.length === 0 &&
              isTerminalEvalRunStatus(item.status)),
        )
        .map(({ run: item }) => item._id),
    [perRun],
  );
  const runWide = useRunsIterations(fallbackIds, fallbackIds.length > 0);

  const suiteAnswer = reads.suite as Answer<EvalSuite>;
  const caseAnswer = reads.testCase as Answer<EvalCase>;

  return useMemo((): TestRunData => {
    const suite = value(suiteAnswer);
    const testCase = value(caseAnswer);
    const fallback = new Set(fallbackIds);
    const iterations = perRun.flatMap(({ run: item, answer }) =>
      fallback.has(item._id)
        ? (runWide.byRun.get(item._id) ?? []).filter(
            (iteration) => matrixCaseKey(iteration) === testCaseId,
          )
        : (value(answer)?.page ?? []),
    );
    const truncated = perRun.some(
      ({ run: item, answer }) =>
        !fallback.has(item._id) && value(answer)?.isDone === false,
    );
    const title =
      testCase?.title ?? iterations[0]?.testCaseSnapshot?.title ?? "";
    const loading =
      selected.isLoading ||
      launch.loading ||
      suiteAnswer === undefined ||
      caseAnswer === undefined ||
      perRun.some(({ answer }) => answer === undefined) ||
      runWide.isLoading;
    const empty = {
      suite,
      run,
      launchRuns: launch.runs,
      iterations,
      source: fallback.size > 0 ? ("runWide" as const) : ("case" as const),
      truncated,
      testCase,
      title,
      matrix: null,
    };
    if (selected.isUnavailable) return { ...empty, status: "runNotFound" };
    if (loading || !run) return { ...empty, status: "loading" };
    const planned = launch.runs.some((item) =>
      (item.configSnapshot?.tests ?? []).some(
        (test) => test.testCaseId === testCaseId,
      ),
    );
    if (iterations.length === 0 && !planned) {
      return { ...empty, status: "caseNotInRun" };
    }
    const matrix = buildRunResultsMatrix({
      run,
      runs: launch.runs,
      iterations,
      hostNamesById: buildHostNamesById(suite?.hostAttachments, undefined),
    });
    return { ...empty, matrix, status: "ready" };
  }, [
    suiteAnswer,
    caseAnswer,
    perRun,
    fallbackIds,
    launch,
    runWide,
    selected.isLoading,
    selected.isUnavailable,
    run,
    testCaseId,
  ]);
}
