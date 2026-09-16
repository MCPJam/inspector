import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EvaluateHistoryHeader,
  EvaluateHistoryRow,
  EvaluateHistoryRowSkeleton,
  historyResult,
} from "../evaluate-history-row";
import type { ProjectRunRow } from "../../evals/project-runs-table";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

const row = (overrides: Partial<ProjectRunRow> = {}): ProjectRunRow => ({
  _id: "run-1",
  suiteId: "suite-1",
  suiteName: "Diagrams",
  runNumber: 3,
  status: "completed",
  result: "passed",
  source: "ui",
  suiteSource: "ui",
  createdAt: 1000,
  completedAt: 3000,
  durationMs: 2000,
  createdBy: "user",
  createdByName: null,
  createdByImageUrl: null,
  ciMetadata: null,
  summary: { passed: 1, failed: 0, total: 1, passRate: 100 },
  ...overrides,
});

describe("Evaluate history rows", () => {
  it("shows only the commit for runs sharing a commit across branches and PRs", () => {
    const git = {
      repositoryUrl: "https://github.com/example/repo",
      commitSha: "abc1234",
      branch: "first",
      prUrl: "https://github.com/example/repo/pull/1",
    };
    render(
      <table>
        <tbody>
          <EvaluateHistoryRow
            rows={[
              row({ _id: "one", ciMetadata: git }),
              row({ _id: "two", ciMetadata: { ...git, branch: "second" } }),
              row({
                _id: "three",
                ciMetadata: {
                  ...git,
                  prUrl: "https://github.com/example/repo/pull/2",
                },
              }),
              row({ _id: "duplicate", ciMetadata: git }),
            ]}
            details={new Map()}
            historyRows={new Map()}
          />
        </tbody>
      </table>,
    );
    expect(screen.getAllByRole("link", { name: "abc1234" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "second" })).toBeNull();
    expect(screen.queryByRole("link", { name: "#2" })).toBeNull();
    expect(screen.getByText("UI")).toHaveClass("text-muted-foreground");
    expect(screen.getByText("UI")).not.toHaveAttribute("data-slot", "badge");
    expect(screen.getByText("UI")).toHaveAttribute("title");
  });

  it("does not infer a result from the pass percentage", () => {
    expect(historyResult([row({ result: "pending" })])).toBe("No result");
    expect(historyResult([row({ result: "failed" })])).toBe("Failed");
    expect(
      historyResult([row(), row({ status: "running", result: "pending" })]),
    ).toBe("Running");
    expect(historyResult([row({ status: "grading", result: "pending" })])).toBe(
      "Grading",
    );
    expect(
      historyResult([row({ status: "timed_out", result: "pending" })]),
    ).toBe("Timed out");
    expect(
      historyResult([row({ status: "cancelled", result: "pending" })]),
    ).toBe("Cancelled");
    expect(historyResult([])).toBe("No result");
  });

  it("keeps zero measurements distinct from missing data and supports keyboard navigation", async () => {
    const run = row();
    const onOpen = vi.fn();
    const renderRow = (iterations: EvalIteration[]) => (
      <table>
        <EvaluateHistoryHeader showSuite />
        <tbody>
          <EvaluateHistoryRow
            rows={[run]}
            showSuite
            historyRows={new Map()}
            details={
              new Map([
                [run._id, { run: run as unknown as EvalSuiteRun, iterations }],
              ])
            }
            onOpen={onOpen}
          />
        </tbody>
      </table>
    );
    const { rerender } = render(
      renderRow([
        {
          _id: "it",
          suiteRunId: run._id,
          status: "completed",
          result: "passed",
          tokensUsed: 0,
          actualToolCalls: [],
        } as unknown as EvalIteration,
      ]),
    );
    const tableRow = screen.getByRole("button", { name: "Open run #3" });
    expect(within(tableRow).getAllByText("0")).toHaveLength(2);
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual([
      "Run",
      "Suite",
      "Client",
      "Model",
      "Result",
      "Rate",
      "Platform",
      "Commit",
      "Date",
      "Latency",
      "Tokens",
      "Calls",
    ]);
    tableRow.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(renderRow([]));
    const cells = screen
      .getByRole("button", { name: "Open run #3" })
      .querySelectorAll("td");
    expect(cells[10]).toHaveTextContent("—");
    expect(cells[11]).toHaveTextContent("—");
  });

  it("withholds aggregate metrics until every member of a launch has loaded", () => {
    const run = row();
    render(
      <table>
        <tbody>
          <EvaluateHistoryRow
            rows={[run, row({ _id: "missing", runNumber: 4 })]}
            historyRows={new Map()}
            details={
              new Map([
                [
                  run._id,
                  { run: run as unknown as EvalSuiteRun, iterations: [] },
                ],
              ])
            }
          />
        </tbody>
      </table>,
    );
    const cells = screen.getByRole("row").querySelectorAll("td");
    expect(cells[4]).toHaveTextContent("—");
    expect(cells[9]).toHaveTextContent("—");
    expect(cells[10]).toHaveTextContent("—");
  });

  it("draws an all-skeleton row, since an unread launch is not yet a row", () => {
    render(
      <table>
        <tbody>
          <EvaluateHistoryRowSkeleton showSuite />
        </tbody>
      </table>,
    );
    // aria-hidden, so the row is absent from the a11y tree by design: the
    // table's footer already announces that the history is loading.
    expect(screen.queryByRole("row")).toBeNull();
    const cells = screen
      .getByTestId("run-history-row-skeleton")
      .querySelectorAll("td");
    // One per header column, so the columns do not jump when the row lands.
    expect(cells).toHaveLength(12);
    for (const cell of cells) {
      expect(cell.querySelector('[data-slot="skeleton"]')).not.toBeNull();
      expect(cell).not.toHaveTextContent("—");
    }
  });
});
