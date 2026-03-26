import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { CiSuiteListSidebar } from "../ci-suite-list-sidebar";

vi.mock("../pass-rate-trend-mini", () => ({
  PassRateTrendMini: () => <div data-testid="pass-rate-trend-mini" />,
}));

vi.mock("../commit-list-sidebar", () => ({
  CommitListSidebar: () => <div data-testid="commit-list-sidebar" />,
}));

describe("CiSuiteListSidebar", () => {
  it("enables rerun and shows replay copy when live servers are missing but replay is available", () => {
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
              createdAt: 1,
              updatedAt: 1,
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
              hasServerReplayConfig: true,
              createdAt: 1,
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
        connectedServerNames={new Set()}
        onRerunSuite={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByText("Will use saved replay config.")).toBeTruthy();
    expect(screen.getByTitle("Run now")).not.toBeDisabled();
  });
});
