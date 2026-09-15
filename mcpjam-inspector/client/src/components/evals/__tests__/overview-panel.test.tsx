import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalSuiteOverviewEntry } from "../types";
import { OverviewPanel } from "../overview-panel";

function makeOverviewEntry(): EvalSuiteOverviewEntry {
  return {
    suite: {
      _id: "suite-1",
      createdBy: "user-1",
      projectId: "ws-1",
      name: "Greeting Suite",
      description: "A suite for greetings",
      configRevision: "rev-1",
      environment: { servers: ["demo"] },
      createdAt: 1,
      updatedAt: 2,
      source: "ui",
    },
    latestRun: {
      _id: "run-1",
      suiteId: "suite-1",
      createdBy: "user-1",
      projectId: "ws-1",
      runNumber: 1,
      configRevision: "rev-1",
      configSnapshot: {
        tests: [],
        environment: { servers: ["demo"] },
      },
      status: "completed",
      result: "failed",
      summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
      createdAt: 1,
      completedAt: 2,
    },
    recentRuns: [
      {
        _id: "run-1",
        suiteId: "suite-1",
        createdBy: "user-1",
        projectId: "ws-1",
        runNumber: 1,
        configRevision: "rev-1",
        configSnapshot: {
          tests: [],
          environment: { servers: ["demo"] },
        },
        status: "completed",
        result: "failed",
        summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        createdAt: 1,
        completedAt: 2,
      },
    ],
    passRateTrend: [0.5],
    totals: { passed: 1, failed: 1, runs: 1 },
  };
}

describe("OverviewPanel", () => {
  it("keeps alternative tags in the selected commit bucket available", async () => {
    const user = userEvent.setup();
    const suites = ["red", "blue", "green"].map((tag) => {
      const entry = makeOverviewEntry();
      const suiteId = `suite-${tag}`;
      return {
        ...entry,
        suite: { ...entry.suite, _id: suiteId, name: tag, tags: [tag] },
        recentRuns: entry.recentRuns.map((run) => ({
          ...run,
          _id: `run-${tag}`,
          suiteId,
          ciMetadata: { commitSha: tag === "green" ? "bbbbbbb" : "aaaaaaa" },
        })),
      };
    });
    const onFilterTagChange = vi.fn();
    const view = (filterTag: string | null) => (
      <OverviewPanel
        suites={suites}
        allTags={["red", "blue", "green"]}
        filterTag={filterTag}
        onFilterTagChange={onFilterTagChange}
        onSelectSuite={vi.fn()}
        onRerunSuite={vi.fn()}
      />
    );
    const { rerender } = render(view(null));
    await user.click(screen.getByRole("button", { name: /aaaaaaa/ }));
    await user.click(screen.getByRole("button", { name: "red", exact: true }));
    rerender(view("red"));
    expect(screen.getByRole("button", { name: "blue", exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "green", exact: true })).toBeNull();
    await user.click(screen.getByRole("button", { name: "blue", exact: true }));
    expect(onFilterTagChange).toHaveBeenLastCalledWith("blue");
    rerender(view("blue"));
    expect(screen.getByRole("button", { name: "red", exact: true })).toBeVisible();
    expect(screen.getByTitle(/^aaaaaaa /)).toHaveClass("ring-2");
  });

  it("renders suite overview without AI triage summary affordances", () => {
    render(
      <OverviewPanel
        suites={[makeOverviewEntry()]}
        allTags={[]}
        filterTag={null}
        onFilterTagChange={vi.fn()}
        onSelectSuite={vi.fn()}
        onRerunSuite={vi.fn()}
        allCommitGroups={[]}
      />,
    );

    expect(screen.getAllByText("Greeting Suite").length).toBeGreaterThan(0);
    expect(screen.queryByText("AI Overview Summary")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Run AI triage when you want a summary/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Triage failures/i }),
    ).not.toBeInTheDocument();
  });
});
