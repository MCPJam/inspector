import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { CiSuiteListSidebar } from "../ci-suite-list-sidebar";

vi.mock("../commit-list-sidebar", () => ({
  CommitListSidebar: () => <div data-testid="commit-list-sidebar" />,
}));

describe("CiSuiteListSidebar", () => {
  it("renders suite name, last-run tooltip, and relative time in By Suite mode", () => {
    const now = Date.now();
    renderWithProviders(
      <CiSuiteListSidebar
        suites={[
          {
            suite: {
              _id: "suite-1",
              name: "Asana MCP Evals",
              description: "Replayable suite",
              configRevision: "1",
              environment: { servers: ["asana"] },
              createdBy: "user-1",
              createdAt: now,
              updatedAt: now,
            },
            latestRun: {
              _id: "run-1",
              suiteId: "suite-1",
              createdBy: "user-1",
              runNumber: 1,
              configRevision: "1",
              configSnapshot: {
                tests: [],
                environment: { servers: ["asana"] },
              },
              status: "completed",
              result: "passed",
              hasServerReplayConfig: true,
              createdAt: now,
              completedAt: now,
            },
            recentRuns: [],
            passRateTrend: [100],
            totals: {
              passed: 1,
              failed: 0,
              runs: 1,
            },
          },
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        sidebarMode="suites"
        onSidebarModeChange={vi.fn()}
        commitGroups={[]}
        selectedCommitSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    expect(screen.getByText("Asana MCP Evals")).toBeTruthy();
    expect(screen.getByTitle("Last run passed")).toBeTruthy();
    expect(screen.getByText("Just now")).toBeTruthy();
  });
});
