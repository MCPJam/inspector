import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunComparisonPage } from "../run-comparison-page";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

// `RunContextChip` reads the kill-switch. Off is the legacy/host branch, which
// is what these host-backed fixtures are.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

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
    summary: { total: 10, passed: 8, failed: 2, passRate: 80 },
    ...overrides,
  } as unknown as EvalSuiteRun;
}

function trials(runId: string, count: number): EvalIteration[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        _id: `${runId}-it-${index}`,
        suiteRunId: runId,
        testCaseId: `case-${index}`,
        status: "completed",
        result: "passed",
        tokensUsed: 100,
        actualToolCalls: [],
        createdAt: 0,
        startedAt: 0,
        updatedAt: 1000,
      }) as unknown as EvalIteration,
  );
}

const hostNamesById = new Map<string, string | null>([
  ["hostA", "Claude"],
  ["hostB", "Cursor"],
]);

/** Seven runs on one client/model, two on another — the last of each is this launch. */
function scenario() {
  const laneA = [1, 2, 3, 4, 5, 6, 7].map((runNumber) =>
    makeRun({
      _id: `a${runNumber}`,
      runNumber,
      createdAt: 1_700_000_000_000 + runNumber * 1000,
      namedHostId: "hostA",
      effectiveModelId: "m-a",
      // #7 clears the 0.8 bar; everything before it sits at 0.8 exactly.
      ...(runNumber === 7
        ? { summary: { total: 10, passed: 9, failed: 1, passRate: 90 } }
        : {}),
      ...(runNumber === 7 ? { runGroupId: "launch" } : {}),
    }),
  );
  const laneB = [1, 2].map((runNumber) =>
    makeRun({
      _id: `b${runNumber}`,
      runNumber,
      createdAt: 1_700_000_000_000 + runNumber * 1000,
      namedHostId: "hostB",
      effectiveModelId: "m-b",
      summary: { total: 10, passed: 7, failed: 3, passRate: 70 },
      ...(runNumber === 2 ? { runGroupId: "launch" } : {}),
    }),
  );
  const runs = [...laneA, ...laneB];
  return {
    runs,
    currentRun: laneA[6],
    iterations: runs.flatMap((run) => trials(run._id, 10)),
  };
}

function renderPage(onOpenRun = vi.fn()) {
  const { runs, currentRun, iterations } = scenario();
  render(
    <RunComparisonPage
      currentRun={currentRun}
      runs={runs}
      iterations={iterations}
      suiteName="Checkout suite"
      hostNamesById={hostNamesById}
      passThreshold={0.8}
      onBack={vi.fn()}
      onOpenRun={onOpenRun}
    />,
  );
  return { onOpenRun };
}

it("groups every run into its own lane and counts only settled lanes against the threshold", () => {
  renderPage();

  // Lane B's newest run is 70% — settled, and below the bar.
  expect(screen.getByTestId("run-compare-threshold")).toHaveTextContent(
    "Pass threshold 80% · 1 of 2 settled lanes meet it on #7",
  );

  const tables = screen.getAllByRole("table");
  expect(tables).toHaveLength(2);
  expect(
    screen.getByRole("table", { name: "Runs for Claude · m-a" }),
  ).toBeVisible();
  expect(
    screen.getByRole("table", { name: "Runs for Cursor · m-b" }),
  ).toBeVisible();
});

it("previews five runs per lane and reveals the rest on demand", async () => {
  const user = userEvent.setup();
  renderPage();
  const lane = () =>
    within(screen.getByRole("table", { name: "Runs for Claude · m-a" }));

  // Five runs plus the header row.
  expect(lane().getAllByRole("row")).toHaveLength(6);
  await user.click(screen.getByRole("button", { name: "See 2 more" }));
  expect(lane().getAllByRole("row")).toHaveLength(8);

  await user.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(lane().getAllByRole("row")).toHaveLength(6);
});

it("shows each run's movement against the previous run of its own lane", () => {
  renderPage();
  const lane = within(
    screen.getByRole("table", { name: "Runs for Claude · m-a" }),
  );
  // #7 passed 9 of 10 where #6 passed 8 of 10 — measured against #6, not
  // against lane B's run that happened to land in the same launch.
  expect(lane.getByText("+10%")).toBeVisible();
});

it("opens the run a row names", async () => {
  const user = userEvent.setup();
  const { onOpenRun } = renderPage();
  await user.click(screen.getByRole("button", { name: "#6" }));
  expect(onOpenRun).toHaveBeenCalledWith("a6");
});

it("counts a single-run lane in the singular", () => {
  // The first launch of any client/model lands here, so "1 runs" is the common
  // case rather than the edge one.
  const only = makeRun({
    _id: "solo",
    namedHostId: "hostA",
    effectiveModelId: "m-a",
  });
  render(
    <RunComparisonPage
      currentRun={only}
      runs={[only]}
      iterations={trials("solo", 10)}
      suiteName="Checkout suite"
      hostNamesById={hostNamesById}
      passThreshold={0.8}
      onBack={vi.fn()}
      onOpenRun={vi.fn()}
    />,
  );
  expect(screen.getByText("1 run")).toBeVisible();
  expect(screen.queryByText("1 runs")).toBeNull();
});

it("collapses a lane to its header", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole("button", { name: /Claude/ }));
  expect(
    screen.queryByRole("table", { name: "Runs for Claude · m-a" }),
  ).toBeNull();
  // The other lane is untouched.
  expect(
    screen.getByRole("table", { name: "Runs for Cursor · m-b" }),
  ).toBeVisible();
});
