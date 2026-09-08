import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunResultsMatrix } from "../run-results-matrix";
import {
  buildRunResultsMatrix,
  launchRuns,
  resultCounts,
} from "../run-results-matrix-model";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

function run(id: string, overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: "sonnet",
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
    ...overrides,
  } as EvalSuiteRun;
}
function iteration(
  id: string,
  runId: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "refund",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 500,
    actualToolCalls: [],
    startedAt: 1000,
    updatedAt: 2000,
    testCaseSnapshot: {
      title: "Refund order",
      model: "sonnet",
      provider: "anthropic",
      query: "Refund the order",
      expectedToolCalls: [],
    },
    ...overrides,
  } as EvalIteration;
}
const names = new Map([
  ["claude", "Claude"],
  ["cursor", "Cursor"],
]);

describe("run results matrix", () => {
  it("scopes columns to one launch and keeps multiple models on one client separate", () => {
    const current = run("one");
    const sibling = run("two", { effectiveModelId: "opus" });
    const unrelated = run("old", { runGroupId: "older" });
    const foreign = run("foreign", { suiteId: "other-suite" });
    expect(
      launchRuns(current, [current, sibling, unrelated, foreign]).map(
        (item) => item._id,
      ),
    ).toEqual(["one", "two"]);
    expect(
      launchRuns(run("solo", { runGroupId: undefined }), [unrelated]),
    ).toHaveLength(1);
    const matrix = buildRunResultsMatrix({
      run: current,
      runs: [sibling, unrelated],
      iterations: [
        iteration("i1", "one"),
        iteration("i2", "two", { result: "failed" }),
        iteration("old", "old"),
      ],
      hostNamesById: names,
    });
    expect(matrix.targets.map((target) => target.model)).toEqual([
      "sonnet",
      "opus",
    ]);
    expect(
      matrix.targets[0].cells.get("refund")?.map((item) => item._id),
    ).toEqual(["i1"]);
    expect(matrix.targets[1].counts.failed).toBe(1);
    expect(matrix.targets[0].cost.totalUsd).toBeNull();
  });

  it("shows snapshotted cases before iterations arrive without inventing outcomes", () => {
    const pending = run("queued", {
      status: "pending",
      configSnapshot: {
        environment: { servers: [] },
        tests: [
          {
            title: "Awaiting case",
            testCaseId: "waiting",
            model: "sonnet",
          } as never,
        ],
      },
    });
    const matrix = buildRunResultsMatrix({
      run: pending,
      runs: [],
      iterations: [],
      hostNamesById: names,
    });
    expect(matrix.rows).toEqual([
      { key: "waiting", title: "Awaiting case", testCaseId: "waiting" },
    ]);
    expect(matrix.targets[0].counts).toEqual({
      passed: 0,
      failed: 0,
      pending: 0,
      cancelled: 0,
    });
  });

  it("does not turn pending or cancelled iterations into failures", () => {
    expect(
      resultCounts([
        iteration("i1", "one", { result: "pending", status: "running" }),
        iteration("i2", "one", { result: "cancelled", status: "cancelled" }),
        iteration("i3", "one", { result: "timed_out", status: "timed_out" }),
      ]),
    ).toEqual({ passed: 0, failed: 1, pending: 1, cancelled: 1 });
  });

  it("splits legacy mixed-model runs and preserves an empty sibling column", () => {
    const current = run("one", { effectiveModelId: undefined });
    const first = iteration("i1", "one");
    const second = iteration("i2", "one", {
      testCaseSnapshot: { ...first.testCaseSnapshot!, model: "opus" },
    });
    const matrix = buildRunResultsMatrix({
      run: current,
      runs: [run("two", { status: "pending", namedHostId: "cursor" })],
      iterations: [first, second],
      hostNamesById: names,
    });
    expect(matrix.targets.map((target) => target.model)).toEqual([
      "sonnet",
      "opus",
      "sonnet",
    ]);
    expect(matrix.targets[2].iterations).toEqual([]);
  });

  it("reports cell status, latency, usage and cost without inventing missing measurements", () => {
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[
          iteration("one", "one"),
          iteration("two", "one", { result: "failed", tokensUsed: 1500 }),
        ]}
        hostNamesById={names}
      />,
    );
    const cell = within(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    expect(cell.queryByText("1 failed")).toBeNull();
    const bar = cell.getByRole("img", {
      name: "1 passed, 1 failed, 0 in progress, 0 cancelled",
    });
    expect(bar).toBeVisible();
    expect(
      [...bar.children].map((segment) => (segment as HTMLElement).style.width),
    ).toEqual(["50%", "50%"]);
    expect(cell.queryByText("50%")).toBeNull();
    expect(cell.getByText("1/2")).toBeVisible();
    expect(cell.getByText("Fail", { exact: true })).toBeVisible();
    expect(cell.getByText("P50")).toBeVisible();
    expect(cell.getByText("P95")).toBeVisible();
    expect(cell.getByText("2K")).toBeVisible();
    expect(cell.queryByText("Cost")).toBeNull();
    expect(cell.getByText("Tool calls")).toBeVisible();
  });

  it("keeps unfinished and cancelled iterations distinct in the result bar", () => {
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[
          iteration("pass", "one"),
          iteration("pending", "one", { status: "running", result: "pending" }),
          iteration("cancelled", "one", {
            status: "cancelled",
            result: "cancelled",
          }),
          iteration("timeout", "one", {
            status: "timed_out",
            result: "timed_out",
          }),
        ]}
        hostNamesById={names}
      />,
    );
    const cell = within(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    expect(cell.queryByText("25%")).toBeNull();
    expect(cell.getByText("Running")).toBeVisible();
    const bar = cell.getByRole("img", {
      name: "1 passed, 1 failed, 1 in progress, 1 cancelled",
    });
    expect(
      [...bar.children].map((segment) => (segment as HTMLElement).style.width),
    ).toEqual(["25%", "25%", "25%", "25%"]);
  });

  it("filters cases and opens the correct evidence when switching client/model in the drawer", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <RunResultsMatrix
        run={run("one")}
        runs={[run("two", { namedHostId: "cursor", effectiveModelId: "gpt" })]}
        iterations={[
          iteration("pass", "one"),
          iteration("fail", "two", {
            result: "failed",
            error: "Missing reason argument",
          }),
        ]}
        hostNamesById={names}
        onOpenIteration={open}
      />,
    );
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    await user.type(
      screen.getByRole("textbox", { name: "Find a test case" }),
      "not present",
    );
    expect(
      screen.getByText("No cases match these filters."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.click(screen.getByRole("button", { name: "With failures" }));
    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    const drawer = within(screen.getByRole("dialog"));
    await user.click(drawer.getByRole("button", { name: "Cursor · gpt" }));
    expect(drawer.getByText("Missing reason argument")).toBeVisible();
    await user.click(drawer.getByRole("button", { name: "Open details" }));
    expect(open).toHaveBeenCalledWith({
      testCaseId: "refund",
      iterationId: "fail",
    });
  });
});
