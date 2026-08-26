/**
 * Canonical verdicts in the two ROW surfaces: the Evaluate suite run history
 * and the project-wide Runs table.
 *
 * ── The derivation trap ──────────────────────────────────────────────────────
 *
 * Both tables have, until now, shown a verdict the BROWSER computed from
 * iteration rows — `buildSuiteRunHistoryRows` → `resolveRunHistoryVerdict` on
 * one side, `statusMeta` on the other. That is a second reading of a run the
 * run itself already decided, and the two disagree the moment a case has
 * repetitions: a case can pass on threshold with a failing trial under it, and
 * local pass-rate math will happily call that run failed. It also cannot
 * express `inconclusive` or "no verdict" at all.
 *
 * So the load-bearing test in this file is the one that proves local math
 * cannot overwrite a fetched canonical verdict. The rest guard the cost of
 * fetching them: off by default, one row at a time, and never for a run that
 * has not decided anything.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-run-decision-summary-api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/apis/eval-run-decision-summary-api")
    >();
  return { ...actual, fetchEvalRunDecisionSummary: fetchMock };
});

const mocks = vi.hoisted(() => ({
  paginated: {
    current: {
      results: [] as unknown[],
      status: "Exhausted" as string,
      isLoading: false,
      loadMore: vi.fn(),
    },
  },
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => mocks.paginated.current,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

import { ProjectRunsTable, type ProjectRunRow } from "../project-runs-table";
import { SuiteDetailOverview } from "../../evaluate/suite-detail-overview";
import { evalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

const INCONCLUSIVE = readDecisionSummaryFixture(
  "inconclusive-no-gradeable-trials",
);
const PASSED_WITH_FAILING_TRIAL = readDecisionSummaryFixture(
  "mixed-repetitions-case-passes-by-threshold",
);

/**
 * A controllable `IntersectionObserver`.
 *
 * The global test stub never fires, which would make every lazy row look
 * correct by never loading. This one records its targets so a test can put a
 * row "on screen" deliberately, and `autoIntersect` covers the tests that only
 * care about what happens once a row IS visible.
 */
let observers: Array<{
  callback: IntersectionObserverCallback;
  targets: Element[];
}> = [];
let autoIntersect = true;

function installObserver() {
  observers = [];
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
    class {
      private readonly record: {
        callback: IntersectionObserverCallback;
        targets: Element[];
      };
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.targets.push(target);
        if (autoIntersect) {
          this.record.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds: number[] = [];
    } as unknown as typeof IntersectionObserver;
}

function scrollAllIntoView() {
  for (const observer of observers) {
    for (const target of observer.targets) {
      observer.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  evalDecisionSummaryStore.reset();
  autoIntersect = true;
  installObserver();
  mocks.paginated.current = {
    results: [],
    status: "Exhausted",
    isLoading: false,
    loadMore: vi.fn(),
  };
});

afterEach(cleanup);

// ── project runs table ───────────────────────────────────────────────────────

function makeProjectRow(
  overrides: Partial<ProjectRunRow> = {},
): ProjectRunRow {
  return {
    _id: "run_aaaaaaaaaaaa",
    suiteId: "suite_1",
    suiteName: "Checkout suite",
    suiteSource: "sdk",
    runNumber: 1,
    status: "completed",
    result: "passed",
    summary: { total: 4, passed: 3, failed: 1, passRate: 75 },
    source: "sdk",
    ciMetadata: null,
    createdBy: "user_1",
    createdByName: "Ada",
    createdByImageUrl: null,
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_005_000,
    durationMs: 5_000,
    ...overrides,
  };
}

describe("ProjectRunsTable with canonical verdicts", () => {
  it("issues no summary requests at all when the flag is off", async () => {
    mocks.paginated.current = {
      results: [makeProjectRow()],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(<ProjectRunsTable projectId="p1" onSelectRun={vi.fn()} />);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    // And the table still shows exactly what it always did.
    expect(within(screen.getByRole("table")).getByText("Passed")).toBeInTheDocument();
  });

  it("replaces the status-derived label with the run's own verdict", async () => {
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    mocks.paginated.current = {
      results: [makeProjectRow({ status: "completed", result: "passed" })],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(
      <ProjectRunsTable
        projectId="p1"
        onSelectRun={vi.fn()}
        decisionSummaryEnabled
      />,
    );

    // `result: "passed"` locally, `inconclusive` canonically. The run's own
    // decision wins — and this column could not previously say this word.
    await waitFor(() => {
      expect(
        within(screen.getByRole("table")).getByText("Inconclusive"),
      ).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole("table")).queryByText("Passed"),
    ).toBeNull();
  });

  it("shows canonical counts with the population they are in", async () => {
    fetchMock.mockResolvedValue(PASSED_WITH_FAILING_TRIAL);
    mocks.paginated.current = {
      results: [makeProjectRow()],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(
      <ProjectRunsTable
        projectId="p1"
        onSelectRun={vi.fn()}
        decisionSummaryEnabled
      />,
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole("table")).getByText(
          "1 passed · 0 failed · 0 inconclusive of 1 case variant",
        ),
      ).toBeInTheDocument();
    });
    // The unit is rendered, not hidden in a `title` — a tooltip is invisible
    // to anyone scanning the column or using a screen reader.
    expect(
      within(screen.getByRole("table")).getByText("counted in case variant"),
    ).toBeInTheDocument();
    // The locally stored pass rate is replaced, not shown beside the canonical
    // counts where a reader would compare two different populations.
    expect(within(screen.getByRole("table")).queryByText("75%")).toBeNull();
  });

  it("leaves a running row lifecycle-only and asks for nothing", async () => {
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    mocks.paginated.current = {
      results: [makeProjectRow({ status: "running", result: "pending" })],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(
      <ProjectRunsTable
        projectId="p1"
        onSelectRun={vi.fn()}
        decisionSummaryEnabled
      />,
    );
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("table")).getByText("Running"),
    ).toBeInTheDocument();
  });

  it("reads nothing for a 50-row page until its rows are actually seen", async () => {
    autoIntersect = false;
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    mocks.paginated.current = {
      results: Array.from({ length: 50 }, (_, index) =>
        makeProjectRow({ _id: `run_${index.toString().padStart(8, "0")}` }),
      ),
      status: "CanLoadMore",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(
      <ProjectRunsTable
        projectId="p1"
        onSelectRun={vi.fn()}
        decisionSummaryEnabled
      />,
    );
    await Promise.resolve();

    // The burst this prevents: 50 rows painting is not 50 reads.
    expect(fetchMock).not.toHaveBeenCalled();

    scrollAllIntoView();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // And even scrolled-to, the global cap holds the concurrent reads down.
    expect(evalDecisionSummaryStore.activeRequestCount).toBeLessThanOrEqual(4);
  });
});

// ── evaluate suite run history ───────────────────────────────────────────────

function makeSuite(): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "u1",
    name: "checkout-flow",
    description: "",
    configRevision: "1",
    environment: { servers: ["payments"] },
    createdAt: 1,
    updatedAt: 1,
    source: "ui",
    defaultPassCriteria: { minimumPassRate: 80 },
  };
}

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<EvalIteration> & { _id: string },
): EvalIteration {
  return {
    createdBy: "u1",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_008_000,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "Pay invoice",
      query: "Pay",
      provider: "openai",
      model: "gpt-5-nano",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const CASES: EvalCase[] = [
  {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "u1",
    title: "Pay invoice",
    query: "Pay the open invoice",
    models: [{ model: "gpt-5-nano", provider: "openai" }],
    runs: 1,
    expectedToolCalls: [],
  },
];

function historyElement(
  props: { projectId?: string | null; decisionSummaryEnabled?: boolean },
  runs: EvalSuiteRun[],
  iterations: EvalIteration[],
) {
  return (
    <SuiteDetailOverview
      suite={makeSuite()}
      cases={CASES}
      runs={runs}
      runsLoading={false}
      allIterations={iterations}
      hostNamesById={new Map()}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
      {...props}
    />
  );
}

function renderHistory(
  props: { projectId?: string | null; decisionSummaryEnabled?: boolean },
  runs: EvalSuiteRun[],
  iterations: EvalIteration[],
) {
  return render(historyElement(props, runs, iterations));
}

describe("Evaluate suite run history with canonical verdicts", () => {
  it("issues no summary requests at all when the flag is off", async () => {
    renderHistory({ projectId: "p1" }, [makeRun({ _id: "run-1" })], [
      makeIteration({ _id: "i1", suiteRunId: "run-1" }),
    ]);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the canonical verdict override the local pass-rate derivation", async () => {
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    // Locally: one iteration, it failed, pass rate 0, threshold 80 → "Hold".
    // Canonically: the validity phase withheld a verdict entirely.
    renderHistory(
      { projectId: "p1", decisionSummaryEnabled: true },
      [makeRun({ _id: "run-1", result: "failed" })],
      [
        makeIteration({
          _id: "i1",
          suiteRunId: "run-1",
          result: "failed",
          resultSource: "reported",
        }),
      ],
    );

    const row = await screen.findByTestId("suite-run-row-run-1");
    await waitFor(() => {
      expect(within(row).getByText("Inconclusive")).toBeInTheDocument();
    });
    expect(within(row).queryByText("Hold")).toBeNull();
  });

  it("keeps the canonical verdict once fetched, whatever the iterations say", async () => {
    fetchMock.mockResolvedValue(PASSED_WITH_FAILING_TRIAL);
    // A case that passes on threshold with a failing trial under it — the
    // exact shape local pass-rate math gets wrong.
    renderHistory(
      { projectId: "p1", decisionSummaryEnabled: true },
      [makeRun({ _id: "run-1", result: "failed" })],
      [
        makeIteration({
          _id: "i1",
          suiteRunId: "run-1",
          result: "failed",
          resultSource: "reported",
        }),
        makeIteration({
          _id: "i2",
          suiteRunId: "run-1",
          iterationNumber: 2,
          result: "passed",
          resultSource: "reported",
        }),
      ],
    );

    const row = await screen.findByTestId("suite-run-row-run-1");
    await waitFor(() => {
      expect(within(row).getByText("Passed")).toBeInTheDocument();
    });
  });

  it("holds the canonical verdict when the iterations underneath change", async () => {
    fetchMock.mockResolvedValue(PASSED_WITH_FAILING_TRIAL);
    const runs = [makeRun({ _id: "run-1", result: "failed" })];
    const props = { projectId: "p1", decisionSummaryEnabled: true } as const;
    const { rerender } = renderHistory(props, runs, [
      makeIteration({
        _id: "i1",
        suiteRunId: "run-1",
        result: "failed",
        resultSource: "reported",
      }),
    ]);

    const row = await screen.findByTestId("suite-run-row-run-1");
    await waitFor(() => {
      expect(within(row).getByText("Passed")).toBeInTheDocument();
    });

    // Iterations stream in live. Recomputing `buildSuiteRunHistoryRows` must
    // not put a locally derived verdict back over the run's own decision.
    rerender(
      historyElement(props, runs, [
        makeIteration({
          _id: "i1",
          suiteRunId: "run-1",
          result: "failed",
          resultSource: "reported",
        }),
        makeIteration({
          _id: "i2",
          suiteRunId: "run-1",
          iterationNumber: 2,
          result: "failed",
          resultSource: "reported",
        }),
      ]),
    );

    const after = screen.getByTestId("suite-run-row-run-1");
    expect(within(after).getByText("Passed")).toBeInTheDocument();
    expect(within(after).queryByText("Hold")).toBeNull();
  });

  it("reads only the rows the first page shows", async () => {
    autoIntersect = false;
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    const runs = Array.from({ length: 20 }, (_, index) =>
      makeRun({
        _id: `run-${index}`,
        createdAt: 1_700_000_000_000 - index * 1_000,
        completedAt: 1_700_000_000_000 - index * 1_000,
      }),
    );

    renderHistory({ projectId: "p1", decisionSummaryEnabled: true }, runs, []);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Eight visible rows, eight reads — "Show all" must not be able to ask for
    // the whole history at once.
    const runIds = new Set(
      fetchMock.mock.calls.map((call) => (call[0] as { runId: string }).runId),
    );
    expect(runIds.size).toBe(8);
  });

  it("does not read a pending row that has decided nothing", async () => {
    fetchMock.mockResolvedValue(INCONCLUSIVE);
    renderHistory(
      { projectId: "p1", decisionSummaryEnabled: true },
      [makeRun({ _id: "run-1", status: "running", result: "pending" })],
      [],
    );
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await screen.findByTestId("suite-run-row-run-1");
    expect(within(row).getByText("Running")).toBeInTheDocument();
  });
});
