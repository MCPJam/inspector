import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CombinedRunContent,
  combinedReportView,
} from "../combined-run-content";
import { EvaluateRunPage } from "../evaluate-run-page";
import { buildRunVerdictHero } from "../run-verdict-hero-model";
import type { EvalSuiteRun, EvalIteration } from "../../evals/types";
import type { ProjectRunHistoryDetail } from "../../evals/use-project-run-history";

const mocks = vi.hoisted(() => ({
  history: {
    details: new Map<string, ProjectRunHistoryDetail>(),
    loading: false,
    errorCount: 0,
    retry: vi.fn(),
  },
  decision: vi.fn(),
}));
vi.mock("../../evals/use-project-run-history", () => ({
  useProjectRunHistory: () => mocks.history,
}));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  // Fresh empty arrays reproduce the loading/absent response from the real hook.
  useEvalRunDecisionDetail: (args: unknown) => {
    mocks.decision(args);
    return { status: "ready", summary: null, diagnostics: [] };
  },
}));
vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: () => ({ chains: new Map(), status: "ready" }),
}));

function run(
  id: string,
  client: string,
  model: string,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "same",
    namedHostId: client,
    effectiveModelId: model,
    runNumber: Number(id),
    createdAt: Number(id) * 1000,
    status: "completed",
    result: "passed",
    configSnapshot: { tests: [], environment: { servers: [] } },
    ...overrides,
  } as EvalSuiteRun;
}
function iteration(id: string, runId: string, result: string): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "case",
    status: "completed",
    result,
    resultSource: "reported",
    startedAt: 1000,
    updatedAt: 3000,
    tokensUsed: 1000,
    actualToolCalls: [],
    testCaseSnapshot: {
      title: "Read a record",
      model: "model",
      query: "Read",
      expectedToolCalls: [],
    },
  } as EvalIteration;
}
const runs = [
  run("1", "cursor", "anthropic/sonnet"),
  run("2", "cursor", "gpt-5.1"),
  run("3", "chatgpt", "gpt-5.1"),
];
const iterations = [
  iteration("a", "1", "passed"),
  iteration("b", "2", "failed"),
  iteration("c", "3", "timed_out"),
];
const names = new Map([
  ["cursor", "Cursor"],
  ["chatgpt", "ChatGPT"],
]);
const props = {
  projectId: "project",
  run: runs[2],
  runs,
  iterations: [iterations[2]],
  hostNamesById: names,
  decisionSummaryEnabled: true,
};

beforeEach(() => {
  mocks.history.details = new Map(
    runs.map((run) => [
      run._id,
      {
        run,
        iterations: iterations.filter(
          (iteration) => iteration.suiteRunId === run._id,
        ),
      },
    ]),
  );
  mocks.history.loading = false;
  mocks.history.errorCount = 0;
  mocks.decision.mockClear();
});

describe("combined run report", () => {
  it("opens all pairings from any member and filters metrics and columns without changing reports", async () => {
    const user = userEvent.setup();
    render(
      <EvaluateRunPage
        run={runs[0]}
        otherRuns={runs}
        hostNamesById={names}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <CombinedRunContent {...props} />
      </EvaluateRunPage>,
    );
    expect(
      await screen.findByRole("textbox", { name: "Find a test case" }),
    ).toBeVisible();
    expect(screen.queryByText(/All \d+ client\/model pairings/)).toBeNull();
    expect(screen.queryByText(/\d+ of \d+ client\/model pairings/)).toBeNull();
    const matrix = screen.getByTestId("run-results-matrix");
    const toolbar = within(matrix).getByTestId("run-results-toolbar");
    const toolbarControls = [
      within(toolbar).getByRole("textbox", { name: "Find a test case" }),
      within(toolbar).getByRole("combobox", { name: "Filter by status" }),
      within(toolbar).getByRole("combobox", { name: "Filter by client" }),
      within(toolbar).getByRole("combobox", { name: "Filter by model" }),
    ];
    expect(
      toolbarControls.map((control) =>
        toolbarControls[0].compareDocumentPosition(control),
      ),
    ).toEqual([
      0,
      Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
    ]);
    expect(toolbarControls[1].compareDocumentPosition(toolbarControls[2])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      within(matrix).queryByRole("button", { name: "Clear filters" }),
    ).toBeNull();
    const hero = screen.getByTestId("run-verdict-hero");
    expect(within(hero).queryByTestId("run-verdict-stat-delta")).toBeNull();
    expect(screen.queryByTestId("run-verdict-word")).toBeNull();
    expect(screen.queryByTestId("run-header-verdict")).toBeNull();
    const pairingDecisions = screen
      .getAllByTestId("run-header-pairing-decision")
      .map((node) => node.textContent);
    expect(pairingDecisions).toEqual(["SHIP"]);
    const shipPill = screen.getByTestId("run-header-decision-pill");
    expect(shipPill).toHaveAttribute("data-decision", "ship");
    expect(within(shipPill).getAllByLabelText(/ · /)).toHaveLength(3);
    const pairingRows = within(hero).getAllByTestId("run-verdict-pairing");
    expect(pairingRows).toHaveLength(3);
    const rateOf = (row: HTMLElement) =>
      within(row).getByTestId("run-verdict-pairing-rate").textContent;
    expect(pairingRows[0]).toHaveTextContent("Cursor");
    expect(rateOf(pairingRows[0])).toBe("100%");
    expect(rateOf(pairingRows[1])).toBe("0%");
    expect(pairingRows[2]).toHaveTextContent("ChatGPT");
    expect(rateOf(pairingRows[2])).toBe("0%");
    for (const row of pairingRows) {
      expect(within(row).getByText("Passed")).toBeVisible();
      expect(within(row).getByText("Failed")).toBeVisible();
    }
    expect(within(hero).queryByText("1 of 3")).toBeNull();
    expect(within(hero).queryByText(/ of /)).toBeNull();
    // Each row carries its own measurements; there is no rolled-up strip that
    // would report one latency for three different clients.
    expect(within(hero).queryByTestId("run-verdict-stats")).toBeNull();
    expect(
      within(pairingRows[0])
        .getAllByTestId("run-verdict-pairing-stat")
        .map((stat) => stat.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining("P50")]));
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: /Test cases/ })).toBeVisible();
    expect(screen.queryByText("Run results")).toBeNull();
    expect(
      screen.queryByText(
        /Cases down the rows. Clients and models across the columns/,
      ),
    ).toBeNull();
    expect(within(matrix).queryByLabelText(/loaded iterations/)).toBeNull();
    expect(within(matrix).queryByTestId("result-count-bar")).toBeNull();
    for (const run of runs)
      expect(mocks.decision).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run._id, enabled: true }),
      );
    await user.click(
      screen.getByRole("combobox", { name: "Filter by client" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Cursor", exact: true }),
    );
    expect(
      within(matrix).getByRole("button", { name: "Clear filters" }),
    ).toBeVisible();
    expect(screen.queryByText(/client\/model pairing/)).toBeNull();
    expect(within(hero).getAllByTestId("run-verdict-pairing")).toHaveLength(2);
    expect(within(hero).queryByText("1 of 2")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    await user.click(screen.getByRole("combobox", { name: "Filter by model" }));
    await user.click(
      screen.getByRole("option", { name: "gpt-5.1", exact: true }),
    );
    const filteredPairing = within(hero).getByTestId("run-verdict-pairing");
    expect(
      within(filteredPairing).getByTestId("run-verdict-pairing-rate"),
    ).toHaveTextContent("0%");
    expect(
      screen
        .getAllByTestId("run-header-pairing-decision")
        .map((node) => node.textContent),
    ).toEqual(pairingDecisions);
    expect(
      within(screen.getByTestId("run-header-decision-pill")).getAllByLabelText(
        / · /,
      ),
    ).toHaveLength(3);
    expect(
      screen.queryByRole("heading", { name: "Filtered results" }),
    ).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Client report/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      within(matrix).queryByRole("button", { name: "Clear filters" }),
    ).toBeNull();
    expect(within(hero).getAllByTestId("run-verdict-pairing")).toHaveLength(3);
    expect(within(hero).queryByText("1 of 3")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });

  it("keeps the loaded report visible during a background refresh", () => {
    mocks.history.loading = true;
    render(<CombinedRunContent {...props} />);
    expect(screen.getByTestId("run-results-matrix")).toBeVisible();
    expect(
      screen.queryByText("Loading results for every client and model…"),
    ).toBeNull();
  });

  it("withholds partial totals when any pairing is unavailable and supports retry", async () => {
    mocks.history.errorCount = 1;
    mocks.history.details.delete("2");
    render(<CombinedRunContent {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Results unavailable for 1",
    );
    expect(screen.queryByTestId("run-verdict-hero")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry results" }),
    );
    expect(mocks.history.retry).toHaveBeenCalled();
  });

  it("shows metric deltas against the previous combined launch", () => {
    const previousLaunch = [
      run("p1", "cursor", "anthropic/sonnet", {
        runGroupId: "prev",
        runNumber: 1,
        createdAt: 1000,
      }),
      run("p2", "cursor", "gpt-5.1", {
        runGroupId: "prev",
        runNumber: 1,
        createdAt: 1100,
      }),
      run("p3", "chatgpt", "gpt-5.1", {
        runGroupId: "prev",
        runNumber: 1,
        createdAt: 1200,
      }),
    ];
    const previousIterations = previousLaunch.map((member, index) => ({
      ...iteration(`prev-${index}`, member._id, "passed"),
      tokensUsed: 100,
      startedAt: 1000,
      updatedAt: 1500,
    }));
    render(
      <EvaluateRunPage
        run={runs[0]}
        otherRuns={runs}
        hostNamesById={names}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <CombinedRunContent
          {...props}
          siblingRuns={[...previousLaunch, ...runs]}
          allIterations={[...previousIterations, ...iterations]}
          previousRunId="p1"
        />
      </EvaluateRunPage>,
    );
    const hero = screen.getByTestId("run-verdict-hero");
    const pairingRows = within(hero).getAllByTestId("run-verdict-pairing");
    const rateDeltaOf = (row: HTMLElement) =>
      within(within(row).getByTestId("run-verdict-pairing-rate")).queryByTestId(
        "run-verdict-stat-delta",
      );
    // A pairing that held its rate stays silent rather than printing an equals.
    expect(rateDeltaOf(pairingRows[0])).toBeNull();
    expect(within(pairingRows[0]).queryByText("=")).toBeNull();
    // Each regressed pairing reports its own rate drop and the count behind it.
    for (const row of [pairingRows[1], pairingRows[2]]) {
      const rate = rateDeltaOf(row);
      expect(rate).toHaveTextContent("−100%");
      expect(rate).toHaveClass("text-destructive");
      expect(
        within(row)
          .getAllByTestId("run-verdict-stat-delta")
          .map((delta) => delta.textContent),
      ).toContain("−1");
    }
    // Latency and tokens are compared per pairing, so the row whose pass count
    // did not move still reports how much slower it got.
    expect(
      within(pairingRows[0])
        .getAllByTestId("run-verdict-stat-delta")
        .map((delta) => delta.textContent),
    ).toEqual(["+1.5s", "+1.5s", "+900"]);
    // Never one rolled-up figure standing in for three different pairings.
    expect(within(hero).queryByLabelText("−2 vs previous run")).toBeNull();
  });

  it("does not turn mixed or unreadable member decisions into a passing run", () => {
    const base = buildRunVerdictHero({
      run: runs[0],
      iterations,
      decision: { status: "disabled", summary: null, diagnostics: [] },
    });
    const passing = {
      ...base,
      verdict: { word: "Passed", tone: "passed" as const, undecidedLine: null },
    };
    const unknown = {
      ...base,
      verdict: {
        word: "No verdict",
        tone: "neutral" as const,
        undecidedLine: null,
      },
    };
    const report = combinedReportView(
      runs.slice(0, 2),
      iterations,
      [passing, unknown],
      false,
    );
    expect(report.verdict.word).toBe("Mixed results");
    expect(report.stats.iterations).toEqual({ passed: 1, total: 3 });
    expect(combinedReportView(runs, iterations, [passing], false).pending).toBe(
      true,
    );
  });
});
