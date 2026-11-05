import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "../../evals/types";

vi.mock("date-fns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("date-fns")>()),
  formatDistanceToNow: () => "about 1 hour ago",
}));

import { SuiteCards, sortSuiteCards } from "../suite-cards";
import { buildSuiteTrend } from "../suite-trend-model";

const suite = (id: string, name: string): EvalSuite => ({
  _id: id,
  createdBy: "u1",
  name,
  description: "",
  configRevision: "1",
  environment: { servers: ["Excalidraw"] },
  defaultConfig: { modelId: "anthropic/claude-haiku-4.5" },
  createdAt: 1,
  updatedAt: 2,
});

const run = (
  suiteId: string,
  runNumber: number,
  rate: number,
  over: Partial<EvalSuiteRun> = {},
): EvalSuiteRun =>
  ({
    _id: `${suiteId}-run-${runNumber}`,
    suiteId,
    createdBy: "u1",
    runNumber,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: rate >= 1 ? "passed" : "failed",
    createdAt: runNumber * 1000,
    completedAt: runNumber * 1000 + 1,
    summary: {
      total: 3,
      passed: 3 * rate,
      failed: 3 - 3 * rate,
      passRate: rate,
    },
    ...over,
  }) as EvalSuiteRun;

function entry(
  id: string,
  name: string,
  rates: number[],
): EvalSuiteOverviewEntry {
  const runs = rates.map((rate, index) => run(id, index + 1, rate)).reverse();
  return {
    suite: suite(id, name),
    latestRun: runs[0] ?? null,
    recentRuns: runs,
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: runs.length },
  };
}

const overview = [
  entry("flaky", "Excalidraw quickstart", [1, 0.5, 1, 0.5, 1, 0.5]),
  entry("steady", "Asana smoke", [1, 1, 1]),
];

function renderCards(over: Partial<Parameters<typeof SuiteCards>[0]> = {}) {
  const props = {
    overview,
    onSelectSuite: vi.fn(),
    onSelectRun: vi.fn(),
    onRerun: vi.fn(),
    onCancelRun: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  };
  render(<SuiteCards {...props} />);
  return props;
}

const card = (name: string) =>
  screen
    .getAllByTestId("evals-suite-card")
    .find((node) => within(node).queryByText(name))!;

describe("SuiteCards", () => {
  it("shows each suite's average, trend word, last-run verdict and bars", () => {
    renderCards();
    const flaky = within(card("Excalidraw quickstart"));
    expect(flaky.getByTestId("evals-suite-card-average")).toHaveTextContent(
      "75%",
    );
    expect(flaky.getByText("average across the last 6 runs")).toBeTruthy();
    expect(flaky.getByText("Flaky")).toBeTruthy();
    expect(flaky.getByText(/passed 2 of 5/)).toBeTruthy();
    expect(flaky.getByText("Failed 50%")).toBeTruthy();
    expect(
      flaky
        .getAllByRole("button", { name: /^Run #\d/ })
        .map((b) => b.textContent),
    ).toEqual(["#2", "#3", "#4", "#5", "#6"]);
    expect(within(card("Asana smoke")).getByText("Steady")).toBeTruthy();
  });

  it("opens the suite, a run, the run setup and suite settings", async () => {
    const user = userEvent.setup();
    const props = renderCards();
    const flaky = within(card("Excalidraw quickstart"));
    await user.click(
      flaky.getByRole("button", { name: "Excalidraw quickstart" }),
    );
    expect(props.onSelectSuite).toHaveBeenCalledWith("flaky");
    await user.click(flaky.getByRole("button", { name: /^Run #4:/ }));
    expect(props.onSelectRun).toHaveBeenCalledWith({
      suiteId: "flaky",
      runId: "flaky-run-4",
    });
    await user.click(
      flaky.getByRole("button", { name: "Run Excalidraw quickstart" }),
    );
    expect(props.onRerun).toHaveBeenCalledWith(overview[0].suite);
    await user.click(
      flaky.getByRole("button", {
        name: "Suite settings for Excalidraw quickstart",
      }),
    );
    expect(props.onOpenSettings).toHaveBeenCalledWith("flaky");
    // None of the inner controls also opened the suite.
    expect(props.onSelectSuite).toHaveBeenCalledOnce();
  });

  it("sorts by last run, name, or lowest pass rate with unrun suites last", () => {
    const unrun = entry("new", "Brand new", []);
    const rows = [...overview, unrun].map((e) => ({
      entry: e,
      trend: buildSuiteTrend(e),
    }));
    const names = (sort: Parameters<typeof sortSuiteCards>[1]) =>
      sortSuiteCards(rows, sort).map((row) => row.entry.suite.name);
    expect(names("last-run")).toEqual([
      "Excalidraw quickstart",
      "Asana smoke",
      "Brand new",
    ]);
    expect(names("name")).toEqual([
      "Asana smoke",
      "Brand new",
      "Excalidraw quickstart",
    ]);
    expect(names("pass-rate")).toEqual([
      "Excalidraw quickstart",
      "Asana smoke",
      "Brand new",
    ]);
  });

  it("filters by name", async () => {
    const user = userEvent.setup();
    renderCards();
    await user.type(
      screen.getByRole("searchbox", { name: "Search suites" }),
      "asana",
    );
    expect(screen.getAllByTestId("evals-suite-card")).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Search suites" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search suites" }),
      "nothing",
    );
    expect(screen.getByText("No suite names match “nothing”.")).toBeTruthy();
  });

  it("offers Cancel while the latest run is in flight", async () => {
    const user = userEvent.setup();
    const active = entry("live", "Live suite", [1]);
    active.latestRun = run("live", 2, 0, {
      status: "running",
      result: "pending",
    });
    const props = renderCards({ overview: [active] });
    await user.click(
      screen.getByRole("button", { name: "Cancel run for Live suite" }),
    );
    expect(props.onCancelRun).toHaveBeenCalledWith("live-run-2");
    expect(screen.getByText("Running")).toBeTruthy();
  });
});
