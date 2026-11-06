import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "../../../evals/types";

export function makeRun(
  suiteId: string,
  runNumber: number,
  overrides: Partial<EvalSuiteRun> & {
    passed?: number;
    total?: number;
  } = {},
): EvalSuiteRun {
  const { passed = 1, total = 1, ...rest } = overrides;
  return {
    _id: `${suiteId}-run-${runNumber}`,
    suiteId,
    createdBy: "user-1",
    runNumber,
    configRevision: "rev",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: passed === total ? "passed" : "failed",
    summary: {
      passed,
      total,
      failed: total - passed,
      passRate: total ? passed / total : 0,
    },
    createdAt: runNumber * 1000,
    completedAt: runNumber * 1000 + 500,
    ...rest,
  };
}

export function makeSuite(
  id: string,
  overrides: Partial<EvalSuite> = {},
): EvalSuite {
  return {
    _id: id,
    projectId: "P",
    name: id,
    description: "",
    configRevision: "rev",
    environment: { servers: ["server-a"] },
    createdBy: "user-1",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeEntry(
  suite: EvalSuite,
  runs: EvalSuiteRun[],
  latestRun: EvalSuiteRun | null = runs.at(-1) ?? null,
): EvalSuiteOverviewEntry {
  return {
    suite,
    latestRun,
    recentRuns: [...runs].reverse(),
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: runs.length },
  };
}

type SampleRun = [number, number, number, "passed" | "failed"];

/** The brief's sample suites: [runNumber, passed, total, result] per run. */
const SAMPLE: Record<string, SampleRun[]> = {
  "Excalidraw quickstart": [
    [1, 5, 12, "failed"],
    [2, 8, 12, "failed"],
    [3, 35, 36, "passed"],
    [4, 21, 24, "failed"],
    [5, 11, 12, "passed"],
    [6, 8, 12, "failed"],
  ],
  "mcpjam-mcp dogfood (production)": [
    [1, 4, 10, "failed"],
    [2, 5, 10, "failed"],
    [3, 7, 10, "failed"],
    [4, 9, 10, "failed"],
    [5, 10, 10, "passed"],
    [6, 10, 10, "passed"],
  ],
  "Asana onboarding smoke": [
    [1, 9, 9, "passed"],
    [2, 9, 9, "passed"],
    [3, 9, 9, "passed"],
    [4, 9, 9, "passed"],
    [5, 9, 9, "passed"],
    [6, 9, 9, "passed"],
    [7, 3, 9, "failed"],
  ],
  "Excalidraw basics (Sonnet)": [
    [1, 8, 8, "passed"],
    [2, 8, 8, "passed"],
    [3, 8, 8, "passed"],
    [4, 8, 8, "passed"],
    [5, 8, 8, "passed"],
    [6, 7, 8, "passed"],
    [7, 8, 8, "passed"],
    [8, 8, 8, "passed"],
    [9, 8, 8, "passed"],
  ],
};

export function sampleEntry(name: keyof typeof SAMPLE & string) {
  const id = name.replace(/\W+/g, "-");
  const runs = SAMPLE[name].map(([n, passed, total, result]) =>
    makeRun(id, n, { passed, total, result }),
  );
  return makeEntry(makeSuite(id, { name }), runs);
}
