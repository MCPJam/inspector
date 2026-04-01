import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { CiSuiteListSidebar } from "../ci-suite-list-sidebar";

vi.mock("../commit-list-sidebar", () => ({
  CommitListSidebar: () => <div data-testid="commit-list-sidebar" />,
}));

describe("CiSuiteListSidebar", () => {
  it("shows Group By select and switches mode on change", async () => {
    const u = userEvent.setup();
    const onSidebarModeChange = vi.fn();
    renderWithProviders(
      <CiSuiteListSidebar
        suites={[]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        sidebarMode="suites"
        onSidebarModeChange={onSidebarModeChange}
        commitGroups={[]}
        selectedCommitSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    expect(screen.getByText("Group By")).toBeTruthy();
    const select = screen.getByRole("combobox", {
      name: "Group sidebar list by",
    });
    expect(select).toHaveValue("suites");

    await u.selectOptions(select, "runs");
    expect(onSidebarModeChange).toHaveBeenCalledWith("runs");
  });

  it("renders suite name, last-run tooltip, and relative time when grouped by suite", () => {
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
