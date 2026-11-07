/**
 * The data the Evaluate navigation walk runs on: three suites, one three-model
 * launch of `case-sketch`, and the answers the mocked data hooks hand back.
 *
 * Every answer is cached by its arguments, so a hook gets the same object for
 * the same arguments on every render, as Convex's client store does for an
 * unchanged query. A fresh object per call would invent render loops the
 * product does not have. The one exception is the decision read, which really
 * does hand back a new array on every render.
 */
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "../evals/types";
import type { useEvalQueries } from "../evals/use-eval-queries";
import { metricsByRunFromIterations } from "../evals/run-metrics";
import { buildRunResultsMatrix } from "../evaluate/run-results-matrix-model";
import type { TestRunData } from "../evaluate/test-run/use-test-run-data";
import {
  makeEntry,
  makeSuite,
} from "../evaluate/landing/__tests__/suite-card-fixtures";
import {
  CASE_ID,
  CASE_TITLE,
  ITERATIONS,
  RUN_A,
  RUN_B,
  SUITE,
  TEST_CASE,
  fixtureIteration,
  fixtureRun,
} from "../evaluate/test-run/__tests__/test-run-fixtures";

export const PROJECT_ID = "proj00000000000001";

/** `/p/proj00000000000001` + a logical path, e.g. projectUrl("/evaluate/runs"). */
export function projectUrl(logicalPathWithSearchAndHash: string): string {
  return `/p/${PROJECT_ID}${logicalPathWithSearchAndHash}`;
}

export const SUITE_ID = SUITE._id;
export const COPY_SUITE_ID = "suite-asana";
export const CI_SUITE_ID = "suite-linear-ci";
export const SKETCH_ID = CASE_ID;
export const DRAW_ID = "case-draw";
export const COPY_CASE_ID = "case-sketch-copy";

export const SUITE_NAME = "Excalidraw quickstart";
export const COPY_SUITE_NAME = "Asana SDK ingestion";
export const CI_SUITE_NAME = "Linear CI";
export { CASE_TITLE };

export const RUN_C: EvalSuiteRun = fixtureRun("run-c", {
  runNumber: 6,
  effectiveModelId: "google/gemini-2.5-flash",
});

export const LAUNCH_RUNS: readonly EvalSuiteRun[] = [RUN_A, RUN_B, RUN_C];

const gemini = (n: number) =>
  fixtureIteration(`c${n}`, RUN_C._id, {
    iterationNumber: n,
    createdAt: ITERATIONS[0].createdAt + n,
    testCaseSnapshot: {
      title: CASE_TITLE,
      model: "google/gemini-2.5-flash",
      provider: "google",
      query: "Sketch a tiny flow",
      expectedToolCalls: [],
    },
  });

export const ALL_ITERATIONS: readonly EvalIteration[] = [
  ...ITERATIONS,
  gemini(1),
  gemini(2),
  gemini(3),
  gemini(4),
];

export const MATRIX3 = buildRunResultsMatrix({
  run: RUN_A,
  runs: [...LAUNCH_RUNS],
  iterations: [...ALL_ITERATIONS],
  hostNamesById: new Map(),
});

/**
 * The iteration "Open iteration 1 details" opens: iteration #1 of the first
 * model that ran the case, which the Test run page selects by default.
 */
export const FIRST_ITERATION_ID: string = (() => {
  const ran = MATRIX3.targets.filter(
    (target) => (target.cells.get(CASE_ID) ?? []).length > 0,
  );
  const target = ran[0] ?? MATRIX3.targets[0];
  const first = (target?.cells.get(CASE_ID) ?? []).find(
    (item) => item.iterationNumber === 1,
  );
  return first?._id ?? "";
})();

const EXCALIDRAW: EvalSuite = {
  ...SUITE,
  createdBy: "user-1",
  description: "",
  configRevision: "rev-1",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 3,
  source: "ui",
  defaultPassCriteria: { minimumPassRate: 70 },
};
const ASANA = makeSuite(COPY_SUITE_ID, {
  projectId: PROJECT_ID,
  name: COPY_SUITE_NAME,
  environment: { servers: [] },
  source: "ui",
  updatedAt: 2,
});
const LINEAR_CI = makeSuite(CI_SUITE_ID, {
  projectId: PROJECT_ID,
  name: CI_SUITE_NAME,
  environment: { servers: [] },
  source: "sdk",
  updatedAt: 1,
});
const SUITES: readonly EvalSuite[] = [EXCALIDRAW, ASANA, LINEAR_CI];

const OVERVIEW: EvalSuiteOverviewEntry[] = [
  makeEntry(EXCALIDRAW, [...LAUNCH_RUNS], RUN_A),
  makeEntry(ASANA, []),
  makeEntry(LINEAR_CI, []),
];

const DRAW: EvalCase = {
  _id: DRAW_ID,
  testSuiteId: SUITE_ID,
  createdBy: "user-1",
  title: "Draw a rectangle",
  steps: [{ id: "p0", kind: "prompt", prompt: "Draw a rectangle." }],
} as EvalCase;
const ASANA_CASE: EvalCase = {
  _id: "case-asana-1",
  testSuiteId: COPY_SUITE_ID,
  createdBy: "user-1",
  title: "List my projects",
  steps: [{ id: "p0", kind: "prompt", prompt: "List my projects." }],
} as EvalCase;
const SKETCH_COPY: EvalCase = {
  ...TEST_CASE,
  _id: COPY_CASE_ID,
  testSuiteId: COPY_SUITE_ID,
};

const CASES_BY_SUITE: ReadonlyMap<string, EvalCase[]> = new Map([
  [SUITE_ID, [TEST_CASE, DRAW]],
  [COPY_SUITE_ID, [ASANA_CASE, SKETCH_COPY]],
  [CI_SUITE_ID, []],
]);

const RUNS_BY_SUITE: ReadonlyMap<string, EvalSuiteRun[]> = new Map([
  [SUITE_ID, [RUN_C, RUN_B, RUN_A]],
  [COPY_SUITE_ID, []],
  [CI_SUITE_ID, []],
]);

/** The copy mutation's answer for `case-sketch` → `suite-asana`. */
export const COPY_RESULT = { testCaseId: COPY_CASE_ID, title: CASE_TITLE };

/** One cache per answer function, keyed by its arguments. */
function cached<A, T>(build: (args: A) => T): (args: A) => T {
  const cache = new Map<string, { value: T }>();
  return (args) => {
    const key = JSON.stringify(args) ?? "undefined";
    let entry = cache.get(key);
    if (!entry) {
      entry = { value: build(args) };
      cache.set(key, entry);
    }
    return entry.value;
  };
}

const iterationById = new Map(ALL_ITERATIONS.map((item) => [item._id, item]));

function readArg(args: unknown, key: string): unknown {
  return typeof args === "object" && args !== null
    ? Reflect.get(args, key)
    : undefined;
}

const queryAnswer = cached(
  ({ name, args }: { name: string; args: unknown }) => {
    const suiteId = readArg(args, "suiteId");
    switch (name) {
      case "testSuites:getTestSuite":
        return SUITES.find((suite) => suite._id === suiteId) ?? null;
      case "testSuites:listTestCases":
        return typeof suiteId === "string"
          ? (CASES_BY_SUITE.get(suiteId) ?? [])
          : [];
      case "testSuites:getTestIteration": {
        const id = readArg(args, "iterationId");
        return typeof id === "string" ? (iterationById.get(id) ?? null) : null;
      }
      default:
        return undefined;
    }
  },
);

/** Answers `convex/react`'s useQuery / useQueries by function name. */
export function answerQuery(name: string, args: unknown): unknown {
  if (args === "skip") return undefined;
  return queryAnswer({ name, args });
}

type EvalQueries = ReturnType<typeof useEvalQueries>;

const noop = () => undefined;

const evalQueries = cached((selectedSuiteId: string | null): EvalQueries => {
  const entry =
    OVERVIEW.find((item) => item.suite._id === selectedSuiteId) ?? null;
  const runs = selectedSuiteId
    ? (RUNS_BY_SUITE.get(selectedSuiteId) ?? [])
    : [];
  const cases = selectedSuiteId
    ? (CASES_BY_SUITE.get(selectedSuiteId) ?? [])
    : [];
  return {
    suiteOverview: OVERVIEW,
    suiteDetails: entry ? { testCases: cases, iterations: [] } : undefined,
    suiteRuns: runs,
    runHistoryStatus: "Exhausted",
    loadMoreRuns: noop,
    selectedSuiteEntry: entry,
    selectedSuite: entry?.suite ?? null,
    sortedIterations: [],
    runsForSelectedSuite: runs,
    activeIterations: [],
    metricsByRun: metricsByRunFromIterations([]),
    isRunMetricsLoading: false,
    sortedSuites: OVERVIEW,
    isOverviewLoading: false,
    isSuiteDetailsLoading: false,
    isSuiteRunsLoading: false,
    enableOverviewQuery: true,
    enableSuiteDetailsQuery: Boolean(entry),
  };
});

export function evalQueriesFor(selectedSuiteId: string | null): EvalQueries {
  return evalQueries(selectedSuiteId);
}

const runById = new Map(LAUNCH_RUNS.map((run) => [run._id, run]));

const testRunData = cached(
  (ids: {
    suiteId: string;
    runId: string;
    testCaseId: string;
  }): TestRunData => ({
    status: "ready",
    suite: EXCALIDRAW,
    run: runById.get(ids.runId) ?? null,
    launchRuns: [...LAUNCH_RUNS],
    iterations: [...ALL_ITERATIONS],
    source: "case",
    truncated: false,
    testCase: TEST_CASE,
    title: CASE_TITLE,
    matrix: MATRIX3,
  }),
);

export function testRunDataFor(ids: {
  suiteId: string;
  runId: string;
  testCaseId: string;
}): TestRunData {
  return testRunData({
    suiteId: ids.suiteId,
    runId: ids.runId,
    testCaseId: ids.testCaseId,
  });
}

const selectedRun = cached((runId: string | null) => {
  const run = runId ? (runById.get(runId) ?? null) : null;
  return {
    run,
    isLoading: false as const,
    isUnavailable: Boolean(runId) && !run,
  };
});

export function selectedRunFor(runId: string | null): {
  run: EvalSuiteRun | null;
  isLoading: false;
  isUnavailable: boolean;
} {
  return selectedRun(runId);
}

const runsIterations = cached((runIds: readonly string[]) => {
  const wanted = new Set(runIds);
  const iterations = ALL_ITERATIONS.filter((item) =>
    wanted.has(item.suiteRunId ?? ""),
  );
  const byRun = new Map<string, EvalIteration[]>(
    runIds.map((id) => [
      id,
      iterations.filter((item) => item.suiteRunId === id),
    ]),
  );
  return { byRun, failedRunIds: new Set<string>(), iterations };
});

/** `useRunsIterations(runIds)`: every fixture iteration of those runs. */
export function runsIterationsFor(runIds: readonly string[]) {
  return runsIterations([...runIds]);
}

const DIAGNOSTIC_ITEMS: ReadonlyMap<
  string,
  readonly EvalRunDecisionDiagnostic[]
> = new Map([
  [
    RUN_A._id,
    [
      { iterationId: "a1", chain: { status: "absent" } },
      { iterationId: "a2", chain: { status: "absent" } },
    ] as EvalRunDecisionDiagnostic[],
  ],
]);

/** A NEW array of the same item objects on every call, as the real read does. */
export function decisionDiagnosticsFor(
  runId: string,
): EvalRunDecisionDiagnostic[] {
  return [...(DIAGNOSTIC_ITEMS.get(runId) ?? [])];
}

const chains = cached((_runId: string) => ({
  status: "ready" as const,
  chains: new Map(),
}));

/** `useEvalRunIterationChains`: one stable ready answer per run. */
export function iterationChainsFor(runId: string) {
  return chains(runId);
}
