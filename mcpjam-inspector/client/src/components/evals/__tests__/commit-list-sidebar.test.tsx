import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { CommitListSidebar } from "../commit-list-sidebar";
import type { CommitGroup, EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-a",
    suiteId: "suite-a",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

function makeGroup(
  runs: EvalSuiteRun[],
  suiteNames: [string, string][],
): CommitGroup {
  const suiteMap = new Map<string, string>(suiteNames);
  return {
    commitSha: "abc-commit",
    shortSha: "abc1234",
    branch: "main",
    timestamp: 100,
    status: "mixed",
    runs,
    suiteMap,
    summary: {
      total: runs.length,
      passed: runs.filter((r) => r.result === "passed").length,
      failed: runs.filter((r) => r.result === "failed").length,
      running: runs.filter((r) => r.status === "running").length,
    },
  };
}

describe("CommitListSidebar", () => {
  it("expands nested suite rows when commit is selected", () => {
    renderWithProviders(
      <CommitListSidebar
        commitGroups={[
          makeGroup(
            [
              makeRun({
                _id: "r1",
                suiteId: "s1",
                result: "failed",
              }),
              makeRun({
                _id: "r2",
                suiteId: "s2",
                result: "passed",
              }),
            ],
            [
              ["s1", "Suite Alpha"],
              ["s2", "Suite Beta"],
            ],
          ),
        ]}
        selectedCommitSha="abc-commit"
        onSelectCommit={vi.fn()}
        selectedSuiteIdInCommit="s2"
        onSelectSuiteInCommit={vi.fn()}
      />,
    );

    expect(screen.getByText("Suite Alpha")).toBeTruthy();
    expect(screen.getByText("Suite Beta")).toBeTruthy();
  });

  it("calls onSelectSuiteInCommit when a nested suite is clicked", async () => {
    const user = userEvent.setup();
    const onSelectSuiteInCommit = vi.fn();

    renderWithProviders(
      <CommitListSidebar
        commitGroups={[
          makeGroup(
            [
              makeRun({ _id: "r1", suiteId: "s1" }),
              makeRun({ _id: "r2", suiteId: "s2" }),
            ],
            [
              ["s1", "Suite One"],
              ["s2", "Suite Two"],
            ],
          ),
        ]}
        selectedCommitSha="abc-commit"
        onSelectCommit={vi.fn()}
        onSelectSuiteInCommit={onSelectSuiteInCommit}
      />,
    );

    await user.click(screen.getByText("Suite Two"));

    expect(onSelectSuiteInCommit).toHaveBeenCalledWith("s2");
  });
});
