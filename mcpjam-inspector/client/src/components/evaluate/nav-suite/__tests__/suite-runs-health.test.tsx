import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { SuiteHistoryLaunch } from "../../suite-run-history-snapshot";
import { SuiteRunsHealth } from "../suite-runs-health";

function launch(
  runNumber: number,
  passed: number,
  total: number,
  result: SuiteHistoryLaunch["result"] = passed === total ? "passed" : "failed",
): SuiteHistoryLaunch {
  return {
    point: {
      passRate: total ? Math.round((passed / total) * 100) : 0,
      passed,
      failed: total - passed,
      total,
      latencyP50: null,
      latencyP95: null,
      tokens: 0,
      toolCalls: 0,
      costUsd: null,
      costedIterations: 0,
    },
    label: `#${runNumber}`,
    runId: `run-${runNumber}`,
    suiteId: "suite-1",
    runNumber,
    date: Date.UTC(2026, 9, 10 + runNumber, 12),
    result,
  };
}

const sixRuns = [
  launch(1, 5, 12),
  launch(2, 8, 12),
  launch(3, 35, 36),
  launch(4, 21, 24),
  launch(5, 11, 12),
  launch(6, 8, 12),
];

describe("SuiteRunsHealth", () => {
  it.each([
    [[launch(1, 3, 4)], "75%", "average across the last run"],
    [sixRuns, "75%", "average across the last 6 runs"],
    [[launch(1, 0, 0)], "—", "No scored runs"],
  ])("averages the scored launches (%#)", (launches, average, caption) => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={launches}
        threshold={70}
        onOpenRun={vi.fn()}
      />,
    );
    const health = screen.getByTestId("nav-suite-health");
    expect(health).toHaveTextContent(average);
    expect(health).toHaveTextContent(caption);
  });

  it.each([
    [launch(6, 8, 12), "Failed 67%", "text-destructive"],
    [launch(6, 12, 12), "Passed 100%", "text-success"],
  ])("names the last run's result (%#)", (last, verdict, tone) => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={[launch(5, 1, 2), last]}
        threshold={70}
        onOpenRun={vi.fn()}
      />,
    );
    expect(screen.getByText(verdict)).toHaveClass(tone);
    expect(screen.getByTestId("nav-suite-health")).toHaveTextContent(
      `Last run #6 · ${verdict} · ${last.point.passed}/12 passed`,
    );
  });

  it("draws one dated bar per scored launch and the threshold line", () => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={[...sixRuns, launch(7, 0, 0)]}
        threshold={70}
        onOpenRun={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("suite-health-bar")).toHaveLength(6);
    expect(screen.getAllByTestId("suite-health-bar-date")).toHaveLength(6);
    expect(screen.getByTestId("suite-health-threshold")).toHaveAttribute(
      "aria-label",
      "Minimum accuracy: 70%",
    );
  });

  it("draws no threshold line without a threshold", () => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={sixRuns}
        threshold={null}
        onOpenRun={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("suite-health-threshold")).toBeNull();
  });

  it("opens a run from its bar and from the Last run number", async () => {
    const onOpenRun = vi.fn();
    renderWithProviders(
      <SuiteRunsHealth
        launches={sixRuns}
        threshold={70}
        onOpenRun={onOpenRun}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId("suite-health-bar")[1]);
    await user.click(screen.getByRole("button", { name: "#6" }));
    expect(onOpenRun.mock.calls).toEqual([["run-2"], ["run-6"]]);
  });
});
