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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-run-decision-summary-api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/apis/eval-run-decision-summary-api")
    >();
  return { ...actual, fetchEvalRunDecisionSummary: fetchMock };
});

const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn() },
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
  useConvex: () => mocks.convex,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [] }),
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

import { ProjectRunsTable, type ProjectRunRow } from "../project-runs-table";
import { SuiteDetailOverview } from "../../evaluate/suite-detail-overview";
import { evalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../types";

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

function makeProjectRow(overrides: Partial<ProjectRunRow> = {}): ProjectRunRow {
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
    expect(
      within(screen.getByRole("table")).getByText("Passed"),
    ).toBeInTheDocument();
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
    expect(within(screen.getByRole("table")).queryByText("Passed")).toBeNull();
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

  it("never prints stored arithmetic beside a canonical no-counts verdict", async () => {
    // The summary ARRIVED and reported no counts — the contract forbids them
    // on a run with no verdict. Falling back to `row.summary` here would put
    // "No verdict" and "75% (3/4)" in the same row: two readings of one run,
    // which is the whole thing this PR exists to stop.
    fetchMock.mockResolvedValue(
      readDecisionSummaryFixture("non-terminal-run-is-notEstablished"),
    );
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

    const table = () => within(screen.getByRole("table"));
    await waitFor(() => {
      expect(table().getByText("No verdict")).toBeInTheDocument();
    });
    expect(table().getByText("no counts reported")).toBeInTheDocument();
    expect(table().queryByText(/75%/)).toBeNull();
    expect(table().queryByText("Accuracy")).toBeNull();
  });

  it("keeps showing the stored metric for a row it has not read", async () => {
    // The other half of the same rule: before a summary arrives (here: flag
    // off), the stored aggregate is still the only answer this row has, and
    // suppressing it would blank a column for no reason.
    mocks.paginated.current = {
      results: [makeProjectRow()],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    };

    render(<ProjectRunsTable projectId="p1" onSelectRun={vi.fn()} />);

    const table = within(screen.getByRole("table"));
    expect(table.getByText(/75%/)).toBeInTheDocument();
    expect(table.queryByText("no counts reported")).toBeNull();
  });

  it.each([
    ["notFound", "No summary"],
    ["routeUnavailable", "Not available"],
    ["invalidContract", "Invalid summary"],
    ["requestFailed", "Load failed"],
  ] as const)(
    "says the verdict is unreadable (%s) instead of falling back to the local one",
    async (kind, label) => {
      fetchMock.mockRejectedValue(
        new EvalRunDecisionSummaryError(kind, "nope"),
      );
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

      const table = () => within(screen.getByRole("table"));
      await waitFor(() => {
        expect(table().getByText(label)).toBeInTheDocument();
      });
      // The stale local answer must NOT stand in for the run's own. Presenting
      // it with nothing marking it as a derivation is the bug this replaces.
      expect(table().queryByText("Passed")).toBeNull();
      expect(table().queryByText(/75%/)).toBeNull();
    },
  );

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

describe("Evaluate suite run history status", () => {
  it.each([false, true])(
    "does not fetch row verdicts, even when report decisions are enabled (%s)",
    async (decisionSummaryEnabled) => {
      renderHistory(
        { projectId: "p1", decisionSummaryEnabled },
        [makeRun({ _id: "run-1" })],
        [makeIteration({ _id: "i1", suiteRunId: "run-1" })],
      );
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        within(screen.getByTestId("suite-run-row-run-1")).getByText("Finished"),
      ).toBeVisible();
      expect(
        screen.queryByRole("columnheader", { name: "Verdict" }),
      ).toBeNull();
    },
  );

  it("does not fetch verdicts when revealing older runs", async () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      makeRun({
        _id: `run-${index}`,
        runNumber: index + 1,
        createdAt: 1700000000000 - index * 1000,
      }),
    );
    renderHistory({ projectId: "p1", decisionSummaryEnabled: true }, runs, []);
    fireEvent.click(screen.getByRole("button", { name: /view all 20 runs/ }));
    expect(screen.getByTestId("suite-run-row-run-19")).toBeInTheDocument();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an active run without reading a verdict", async () => {
    renderHistory(
      { projectId: "p1", decisionSummaryEnabled: true },
      [makeRun({ _id: "run-1", status: "running", result: "pending" })],
      [],
    );
    expect(
      within(screen.getByTestId("suite-run-row-run-1")).getByText(
        "In progress",
      ),
    ).toBeVisible();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
