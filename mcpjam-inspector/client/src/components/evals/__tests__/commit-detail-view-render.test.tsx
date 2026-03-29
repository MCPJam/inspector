import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CommitGroup, EvalSuiteRun } from "../types";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => ({
    testCases: [],
    iterations: [],
  })),
}));

vi.mock("../use-suite-data", () => ({
  useRunDetailData: vi.fn(() => ({
    caseGroupsForSelectedRun: [],
    selectedRunChartData: {
      donutData: [],
      durationData: [],
      tokensData: [],
      modelData: [],
    },
  })),
}));

vi.mock("../run-detail-view", () => ({
  RunDetailView: () => <div data-testid="run-detail-view">Run detail</div>,
}));

const routerMocks = vi.hoisted(() => ({
  navigateToCiEvalsRoute: vi.fn(),
}));

vi.mock("@/lib/ci-evals-router", () => ({
  navigateToCiEvalsRoute: routerMocks.navigateToCiEvalsRoute,
}));

import { CommitDetailView } from "../commit-detail-view";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "rev-1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "failed",
    summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

function makeCommitGroup(): CommitGroup {
  const run = makeRun();
  return {
    commitSha: "abc1234567",
    shortSha: "abc1234",
    branch: "main",
    timestamp: 2,
    status: "failed",
    runs: [run],
    suiteMap: new Map([[run.suiteId, "Greeting Suite"]]),
    summary: { total: 1, passed: 0, failed: 1, running: 0 },
  };
}

describe("CommitDetailView", () => {
  it("renders run detail without commit triage summary affordances", () => {
    render(
      <CommitDetailView
        commitGroup={makeCommitGroup()}
        route={{
          type: "commit-detail",
          commitSha: "abc1234567",
          suite: "suite-1",
          iteration: null,
        }}
      />,
    );

    expect(screen.getByText("Greeting Suite")).toBeVisible();
    expect(screen.getByTestId("run-detail-view")).toBeVisible();
    expect(screen.queryByText("Commit insights")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Run AI triage when you want a summary/i),
    ).not.toBeInTheDocument();
    expect(routerMocks.navigateToCiEvalsRoute).not.toHaveBeenCalled();
  });
});
