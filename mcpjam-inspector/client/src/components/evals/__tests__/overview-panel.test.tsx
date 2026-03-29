import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvalSuiteOverviewEntry } from "../types";
import { OverviewPanel } from "../overview-panel";

function makeOverviewEntry(): EvalSuiteOverviewEntry {
  return {
    suite: {
      _id: "suite-1",
      createdBy: "user-1",
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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
        workspaceId: "ws-1",
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
    expect(screen.queryByText(/Run AI triage when you want a summary/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Triage failures/i }),
    ).not.toBeInTheDocument();
  });
});
