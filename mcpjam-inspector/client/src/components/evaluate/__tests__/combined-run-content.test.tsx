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

function run(id: string, client: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "same",
    namedHostId: client,
    effectiveModelId: model,
    runNumber: Number(id),
    status: "completed",
    result: "passed",
    configSnapshot: { tests: [], environment: { servers: [] } },
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
      await screen.findByText("All 3 client/model pairings"),
    ).toBeVisible();
    const hero = screen.getByTestId("run-verdict-hero");
    expect(
      screen.getByRole("button", { name: "Clear filters" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("run-verdict-word")).toBeNull();
    const verdict = screen.getByTestId("run-header-verdict").textContent;
    expect(within(hero).getByText("1 of 3")).toBeVisible();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
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
    expect(screen.getByText("2 of 3 client/model pairings")).toBeVisible();
    expect(within(hero).getByText("1 of 2")).toBeVisible();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    await user.click(screen.getByRole("combobox", { name: "Filter by model" }));
    await user.click(
      screen.getByRole("option", { name: "gpt-5.1", exact: true }),
    );
    expect(within(hero).getByText("0 of 1")).toBeVisible();
    expect(screen.getByTestId("run-header-verdict")).toHaveTextContent(
      verdict!,
    );
    expect(
      screen.queryByRole("heading", { name: "Filtered results" }),
    ).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Client report/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(hero).getByText("1 of 3")).toBeVisible();
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
