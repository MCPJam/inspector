import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EvaluateHistoryHeader,
  EvaluateHistoryRow,
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
  it("keeps distinct branch and PR chips for runs sharing a commit", () => {
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
    expect(screen.getAllByRole("link", { name: "abc1234" })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "second" })).toHaveAttribute(
      "href",
      "https://github.com/example/repo/tree/second",
    );
    expect(screen.getByRole("link", { name: "#2" })).toHaveAttribute(
      "href",
      "https://github.com/example/repo/pull/2",
    );
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
      "Client / Model",
      "Result",
      "Rate",
      "Platform",
      "When",
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
    expect(cells[8]).toHaveTextContent("—");
    expect(cells[9]).toHaveTextContent("—");
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
    expect(cells[3]).toHaveTextContent("—");
    expect(cells[7]).toHaveTextContent("—");
    expect(cells[8]).toHaveTextContent("—");
  });
});
