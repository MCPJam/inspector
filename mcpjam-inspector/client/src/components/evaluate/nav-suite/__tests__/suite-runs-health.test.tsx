import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { SuiteHistoryLaunch } from "../../suite-run-history-snapshot";
import { SuiteRunsHealth } from "../suite-runs-health";

function launch(
  runNumber: number,
  passed: number,
  total: number,
  verdict = passed === total ? "Passed" : "Failed",
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
    verdict,
    health: total ? { passed, total } : null,
  };
}

/** A launch still running: on the table, not on the trend. */
const running = (runNumber: number): SuiteHistoryLaunch => ({
  ...launch(runNumber, 2, 10, "Running"),
  health: null,
});

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
    [launch(6, 8, 12), "Failed", "text-destructive", "Last run #6 · Failed · 67% passed · 8/12"],
    [launch(6, 12, 12), "Passed", "text-foreground", "Last run #6 · Passed · 100% passed · 12/12"],
    [running(6), "Running", "text-foreground", "Last run #6 · Running"],
  ])("names the last run's verdict as the table does (%#)", (last, verdict, tone, line) => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={[launch(5, 1, 2), last]}
        threshold={70}
        onOpenRun={vi.fn()}
      />,
    );
    expect(screen.getByText(verdict)).toHaveClass(tone);
    expect(screen.getByTestId("nav-suite-health")).toHaveTextContent(line);
  });

  it("names as Last run the launch with the latest run, as the table does", () => {
    const early = { ...launch(1, 3, 4), date: Date.UTC(2026, 9, 20) };
    const later = { ...launch(2, 4, 4), date: Date.UTC(2026, 9, 18) };
    renderWithProviders(
      <SuiteRunsHealth
        launches={[early, later]}
        threshold={null}
        onOpenRun={vi.fn()}
      />,
    );
    expect(screen.getByTestId("nav-suite-health")).toHaveTextContent(
      "Last run #1 · Failed",
    );
  });

  it("leaves a running launch out of the average and the bars", () => {
    renderWithProviders(
      <SuiteRunsHealth
        launches={[...sixRuns, running(7)]}
        threshold={70}
        onOpenRun={vi.fn()}
      />,
    );
    const health = screen.getByRole("region", { name: "Suite health" });
    expect(health).toHaveTextContent("75%");
    expect(health).toHaveTextContent("average across the last 6 runs");
    expect(health).toHaveTextContent("Last run #7 · Running");
    expect(screen.getAllByTestId("suite-health-bar")).toHaveLength(6);
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
