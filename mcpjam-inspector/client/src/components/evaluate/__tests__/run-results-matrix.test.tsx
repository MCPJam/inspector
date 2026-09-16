import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunResultsMatrix } from "../run-results-matrix";
import {
  buildRunResultsMatrix,
  launchRuns,
  resultCounts,
  cellResult,
} from "../run-results-matrix-model";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => undefined,
}));

function run(id: string, overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: "sonnet",
    runNumber: 3,
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
  it.each([
    [[], null],
    [["passed", "passed"], "passed"],
    [["passed", "failed"], "failed"],
    [["passed", "timed_out"], "failed"],
    [["passed", "cancelled"], "cancelled"],
    [["failed", "cancelled"], "failed"],
    [["passed", "failed", "pending"], "pending"],
  ] as const)("uses the displayed result for %j", (results, expected) => {
    expect(
      cellResult(
        results.map((result, index) =>
          iteration(String(index), "one", {
            result,
            status:
              result === "pending"
                ? "running"
                : result === "cancelled"
                  ? "cancelled"
                  : result === "timed_out"
                    ? "timed_out"
                    : "completed",
          }),
        ),
      ),
    ).toBe(expected);
  });

  it("opens the test case from the left column in Results and Metrics", async () => {
    const user = userEvent.setup();
    const onEditCase = vi.fn();
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[iteration("pass", "one")]}
        hostNamesById={names}
        onEditCase={onEditCase}
      />,
    );
    const caseButton = screen.getByRole("button", {
      name: "Open test case: Refund order",
    });
    expect(caseButton).toHaveClass("min-h-16", "text-foreground");
    expect(caseButton).not.toHaveClass("hover:underline", "hover:bg-muted/30");
    expect(caseButton.closest("th")).toHaveClass("hover:bg-muted/50");
    await user.click(caseButton);
    expect(onEditCase).toHaveBeenLastCalledWith("refund");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Metrics" }));
    screen
      .getByRole("button", { name: "Open test case: Refund order" })
      .focus();
    await user.keyboard("{Enter}");
    expect(onEditCase).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps case names as text when navigation or a saved case ID is missing", () => {
    const props = {
      run: run("one"),
      iterations: [iteration("pass", "one")],
      hostNamesById: names,
    };
    const { rerender } = render(<RunResultsMatrix {...props} />);
    expect(
      screen.queryByRole("button", { name: /Open test case:/ }),
    ).toBeNull();
    rerender(
      <RunResultsMatrix
        {...props}
        iterations={[iteration("pass", "one", { testCaseId: undefined })]}
        onEditCase={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Open test case:/ }),
    ).toBeNull();
    expect(
      screen.getByRole("rowheader", { name: "Refund order" }),
    ).toBeVisible();
  });

  it("renders result fractions with the larger dark design treatment", () => {
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[iteration("pass", "one")]}
        hostNamesById={names}
      />,
    );
    expect(screen.getByLabelText("1 of 1 iterations passed")).toHaveClass(
      "text-lg",
      "font-semibold",
      "text-card-foreground",
    );
  });

  it("opens evaluator settings from the iteration scorecard", async () => {
    const onEditEvaluator = vi.fn();
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[iteration("pass", "one")]}
        hostNamesById={names}
        onEditEvaluator={onEditEvaluator}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Configure test case evaluators" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Open iteration 1 details" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Configure test case evaluators" }),
    );
    expect(onEditEvaluator).toHaveBeenCalledWith("refund");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the saved case editor and closes the iterations drawer", async () => {
    const onEditCase = vi.fn();
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[iteration("pass", "one")]}
        hostNamesById={names}
        onEditCase={onEditCase}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Edit test case",
      }),
    );
    expect(onEditCase).toHaveBeenCalledWith("refund");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows only the empty state when switching to a pairing without iterations", async () => {
    const user = userEvent.setup();
    render(
      <RunResultsMatrix
        run={run("one")}
        runs={[run("two", { namedHostId: "cursor", effectiveModelId: "gpt" })]}
        iterations={[iteration("pass", "one")]}
        hostNamesById={names}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    const drawer = within(screen.getByRole("dialog"));
    expect(drawer.getByText("1/1")).toBeVisible();
    await user.click(drawer.getByRole("button", { name: "Cursor · gpt" }));
    expect(
      drawer.getAllByText(
        "No recorded iterations for this case on this client and model.",
      ),
    ).toHaveLength(1);
    expect(drawer.queryByText("0/0")).toBeNull();
    expect(drawer.queryByText("Passed")).toBeNull();
    expect(drawer.queryByText("P50")).toBeNull();
    expect(drawer.queryByText("Iterations")).toBeNull();
    expect(drawer.queryByText("Client / Model")).toBeNull();
    await user.click(drawer.getByRole("button", { name: "Claude · sonnet" }));
    expect(drawer.getByText("1/1")).toBeVisible();
  });

  it("uses persisted models only to seed queued columns, never phantom completed columns", () => {
    const current = run("legacy", {
      namedHostId: undefined,
      effectiveModelId: undefined,
      client: { name: "Claude", hostStyle: "claude", source: "suite_default" },
      configSnapshot: {
        environment: { servers: [] },
        tests: [
          {
            title: "Refund order",
            models: [{ model: "sonnet", provider: "anthropic" }],
          } as any,
        ],
      },
    });
    const args = {
      run: current,
      runs: [],
      iterations: [iteration("i", "legacy")],
      hostNamesById: names,
    };
    const completed = buildRunResultsMatrix(args);
    expect(
      completed.targets.map((target) => [target.client, target.modelId]),
    ).toEqual([["Claude", "sonnet"]]);
    const queued = buildRunResultsMatrix({
      ...args,
      run: { ...current, status: "pending" },
      iterations: [],
    });
    expect(queued.targets.map((target) => target.modelId)).toEqual(["sonnet"]);
  });
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

  it("switches each case between results and metrics", async () => {
    const user = userEvent.setup();
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
    expect(cell.queryByText("P50")).toBeNull();
    expect(screen.getByRole("radio", { name: "Results" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Metrics" }));
    expect(cell.queryByText("Fail", { exact: true })).toBeNull();
    expect(cell.queryByRole("img")).toBeNull();
    expect(cell.getByText("P50")).toBeVisible();
    expect(cell.getByText("P95")).toBeVisible();
    expect(cell.getByText("1k")).toBeVisible();
    expect(cell.queryByText("Cost")).toBeNull();
    expect(cell.getByText("Calls")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Metrics" })).toBeChecked();
    expect(
      screen.getByRole("columnheader", { name: "Test case" }),
    ).toBeVisible();
    // One row, so the heading counts in the singular rather than "1 Test cases".
    const title = screen.getByRole("heading", { name: "1 Test case" });
    expect(title).toBeVisible();
    expect(
      title.compareDocumentPosition(screen.getByTestId("run-results-toolbar")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText("Run results")).toBeNull();
    expect(
      screen.queryByText(
        /Cases down the rows. Clients and models across the columns/,
      ),
    ).toBeNull();
    expect(screen.queryByLabelText(/loaded iterations/)).toBeNull();
    expect(screen.queryByTestId("result-count-bar")).toBeNull();
    expect(screen.queryByText("1 passed")).toBeNull();
    expect(screen.queryByText("1 failed")).toBeNull();
    expect(screen.queryByText("Failures first")).toBeNull();
    expect(
      screen.queryByText(/Showing recorded iterations from this run/),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    const toolbar = screen.getByTestId("run-results-toolbar");
    const search = within(toolbar).getByRole("textbox", {
      name: "Find a test case",
    });
    const status = within(toolbar).getByRole("combobox", {
      name: "Filter by status",
    });
    expect(search.compareDocumentPosition(status)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByRole("button", { name: "All cases" })).toBeNull();
    expect(screen.queryByRole("button", { name: "With failures" })).toBeNull();
    expect(screen.queryByRole("button", { name: "In progress" })).toBeNull();
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

  it("does not treat a whitespace-only search as an active filter", async () => {
    const user = userEvent.setup();
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[
          iteration("pass", "one", {
            testCaseSnapshot: {
              title: "Checkout",
              model: "sonnet",
              provider: "anthropic",
              query: "Checkout",
              expectedToolCalls: [],
            },
          }),
        ]}
        hostNamesById={names}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Find a test case" }),
      " ",
    );
    expect(
      screen.getByRole("button", {
        name: "Inspect Checkout on Claude · sonnet",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("filters by the displayed cell result instead of any passing iteration", async () => {
    const user = userEvent.setup();
    render(
      <RunResultsMatrix
        run={run("one")}
        runs={[run("two", { namedHostId: "cursor", effectiveModelId: "gpt" })]}
        iterations={[
          iteration("mixed-pass", "one"),
          iteration("mixed-fail", "one", { result: "failed" }),
          iteration("other-fail", "two", { result: "failed" }),
          iteration("clean-pass", "one", {
            testCaseId: "clean",
            testCaseSnapshot: {
              ...iteration("base", "one").testCaseSnapshot!,
              title: "Clean case",
            },
          }),
        ]}
        hostNamesById={names}
      />,
    );
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    await user.click(screen.getByRole("option", { name: "Passed" }));
    expect(screen.queryByText("Refund order")).toBeNull();
    expect(screen.getByText("Clean case")).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    await user.click(screen.getByRole("option", { name: "Failures" }));
    expect(screen.getByText("Refund order")).toBeVisible();
    expect(screen.queryByText("Clean case")).toBeNull();
  });

  it("filters cases and opens the correct evidence when switching client/model in the drawer", async () => {
    const user = userEvent.setup();
    render(
      <RunResultsMatrix
        run={run("one")}
        suiteName="excalidraw"
        runs={[run("two", { namedHostId: "cursor", effectiveModelId: "gpt" })]}
        iterations={[
          iteration("pass", "one"),
          iteration("fail", "two", {
            result: "failed",
            error: "Missing reason argument",
          }),
        ]}
        hostNamesById={names}
      />,
    );
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "Find a test case" }),
      "not present",
    );
    expect(
      screen.getByText("No cases match these filters."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    expect(screen.getByRole("option", { name: "Failures" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Passed" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Pending" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Failures" }));
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    const drawer = within(screen.getByRole("dialog"));
    expect(drawer.getByRole("heading", { name: "Refund order" })).toBeVisible();
    expect(drawer.getByText("Test case averages")).toBeVisible();
    expect(drawer.getByText("Iterations")).toBeVisible();
    expect(drawer.getByText("Client / Model")).toBeVisible();
    await user.click(drawer.getByRole("button", { name: "Cursor · gpt" }));
    expect(drawer.getByText("Failed")).toBeVisible();
    await user.click(
      drawer.getByRole("button", { name: "Open iteration 1 details" }),
    );
    expect(
      drawer.getByRole("button", { name: "Back to test case iterations" }),
    ).toHaveTextContent("Refund order › Run #3");
    expect(
      drawer.getByRole("heading", { name: "#1 excalidraw" }),
    ).toBeVisible();
    expect(drawer.getByText("Failed")).toBeVisible();
    expect(drawer.getByRole("button", { name: "Scorecard" })).toBeVisible();
  });

  it.each([
    ["passed", "Passed"],
    ["failed", "Failures"],
    ["pending", "Pending"],
    ["cancelled", "Cancelled"],
  ] as const)(
    "clears %s only when no visible cell still matches",
    async (result, label) => {
      const user = userEvent.setup();
      const onFilterChange = vi.fn();
      const props = {
        run: run("one", { status: "running" }),
        hostNamesById: names,
        onFilterChange,
      };
      const match = iteration("match", "one", {
        result,
        status:
          result === "pending"
            ? "running"
            : result === "cancelled"
              ? "cancelled"
              : "completed",
      });
      const { rerender } = render(
        <RunResultsMatrix {...props} iterations={[match]} />,
      );
      await user.click(
        screen.getByRole("combobox", { name: "Filter by status" }),
      );
      await user.click(screen.getByRole("option", { name: label }));
      rerender(<RunResultsMatrix {...props} iterations={[{ ...match }]} />);
      expect(
        screen.getByRole("combobox", { name: "Filter by status" }),
      ).toHaveTextContent(label);
      expect(onFilterChange).toHaveBeenLastCalledWith({
        search: "",
        status: result,
      });
      rerender(
        <RunResultsMatrix
          {...props}
          iterations={[
            iteration("changed", "one", {
              result: result === "passed" ? "failed" : "passed",
            }),
          ]}
        />,
      );
      expect(
        screen.getByRole("combobox", { name: "Filter by status" }),
      ).toHaveTextContent("Status");
      expect(onFilterChange).toHaveBeenLastCalledWith({
        search: "",
        status: "__all__",
      });
      expect(
        screen.getByRole("button", {
          name: "Inspect Refund order on Claude · sonnet",
        }),
      ).toBeVisible();
    },
  );

  it("keeps Pending while a run is live and hides it once every run is terminal", async () => {
    const user = userEvent.setup();
    const live = run("one", { status: "running" });
    const { rerender } = render(
      <RunResultsMatrix
        run={live}
        iterations={[
          iteration("pass", "one"),
          iteration("pending", "one", { status: "running", result: "pending" }),
        ]}
        hostNamesById={names}
      />,
    );
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    expect(screen.getByRole("option", { name: "Pending" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "Pending" }));
    expect(
      screen.getByRole("combobox", { name: "Filter by status" }),
    ).toHaveTextContent("Pending");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
    rerender(
      <RunResultsMatrix
        run={run("one", { status: "completed" })}
        iterations={[
          iteration("pass", "one"),
          iteration("fail", "one", { result: "failed" }),
        ]}
        hostNamesById={names}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Filter by status" }),
    ).toHaveTextContent("Status");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    expect(screen.queryByRole("option", { name: "Pending" })).toBeNull();
    expect(screen.getByRole("option", { name: "Failures" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Passed" })).toBeNull();
  });

  it.each(["pending", "running", "grading"] as const)(
    "hides Pending when no pending cases exist while status is %s",
    async (status) => {
      const user = userEvent.setup();
      render(
        <RunResultsMatrix
          run={run("one", { status })}
          iterations={[iteration("one", "one")]}
          hostNamesById={names}
        />,
      );
      await user.click(
        screen.getByRole("combobox", { name: "Filter by status" }),
      );
      expect(screen.queryByRole("option", { name: "Pending" })).toBeNull();
    },
  );
});

describe("test-name navigation", () => {
  it.each(["sdk", "ui"] as const)(
    "opens the saved definition for %s cases instead of run details",
    async (source) => {
      const onEditCase = vi.fn();
      render(
        <RunResultsMatrix
          run={run("one", { source })}
          iterations={[iteration("only", "one")]}
          onEditCase={onEditCase}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Open test case: Refund order" }),
      );
      expect(onEditCase).toHaveBeenCalledWith("refund");
      expect(screen.queryByRole("dialog")).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: /Inspect Refund order on/ }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(onEditCase).toHaveBeenCalledTimes(1);
    },
  );
});
