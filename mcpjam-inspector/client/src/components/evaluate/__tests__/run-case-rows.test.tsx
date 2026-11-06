import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { buildRunResultsMatrix } from "../run-results-matrix-model";
import { RunTestRuns, testRunVerdict } from "../run-case-rows";

function iteration(
  overrides: Partial<EvalIteration> & { _id: string },
): EvalIteration {
  return {
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    suiteRunId: "run-1",
    testCaseId: "case-1",
    testCaseSnapshot: {
      title: "Draw a rectangle",
      query: "Draw",
      provider: "openai",
      model: "gpt-5-mini",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const results = (...list: EvalIteration["result"][]) =>
  list.map((result, index) =>
    iteration({
      _id: `i${index}`,
      result,
      status: result === "pending" ? "running" : "completed",
    }),
  );

describe("testRunVerdict", () => {
  it.each<
    [string, EvalIteration[], number | null, ReturnType<typeof testRunVerdict>]
  >([
    ["every iteration passed", results("passed", "passed"), 0.7, "passed"],
    [
      "flaky at the threshold",
      results("passed", "passed", "passed", "failed"),
      0.75,
      "flaky",
    ],
    [
      "flaky above the threshold",
      results("passed", "passed", "passed", "failed"),
      0.7,
      "flaky",
    ],
    ["failed below the threshold", results("passed", "failed"), 0.7, "failed"],
    [
      "running while any is pending",
      results("passed", "pending"),
      0.7,
      "pending",
    ],
    [
      "cancelled when nothing decided",
      results("cancelled", "cancelled"),
      0.7,
      "cancelled",
    ],
    [
      "no threshold counts as 100%",
      results("passed", "passed", "failed"),
      null,
      "failed",
    ],
    ["nothing to judge", [], 0.7, null],
  ])("%s", (_, items, threshold, expected) => {
    expect(testRunVerdict(items, threshold)).toBe(expected);
  });

  it("leaves cancelled iterations out of the passed share", () => {
    expect(testRunVerdict(results("passed", "passed", "cancelled"), 1)).toBe(
      "passed",
    );
    expect(
      testRunVerdict(
        results("passed", "passed", "passed", "failed", "cancelled"),
        0.75,
      ),
    ).toBe("flaky");
  });
});

function run(id: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 4,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    namedHostId: "host-1",
    effectiveModelId: model,
  };
}

function caseRows(
  runId: string,
  model: string,
  title: string,
  testCaseId: string | undefined,
  outcomes: EvalIteration["result"][],
) {
  return outcomes.map((result, index) =>
    iteration({
      _id: `${runId}-${title}-${index}`,
      suiteRunId: runId,
      result,
      testCaseId,
      testCaseSnapshot: {
        title,
        query: title,
        provider: "openai",
        model,
        expectedToolCalls: [],
      },
    }),
  );
}

function matrixOf(iterations: EvalIteration[], models = ["gpt-5-mini"]) {
  const runs = models.map((model, index) => ({
    ...run(`run-${index + 1}`, model),
    runGroupId: "g",
  }));
  return buildRunResultsMatrix({
    run: runs[0],
    runs,
    iterations,
    hostNamesById: new Map([["host-1", "MCPJam"]]),
  });
}

const titles = () =>
  screen
    .getAllByTestId("test-run-row")
    .map((row) => within(row).getAllByRole("button")[0].textContent);

describe("RunTestRuns", () => {
  const mixed = [
    ...caseRows("run-1", "gpt-5-mini", "Draw a rectangle", "case-a", [
      "passed",
      "passed",
    ]),
    ...caseRows("run-1", "gpt-5-mini", "Sketch a two-node flow", "case-b", [
      "passed",
      "failed",
      "failed",
      "failed",
    ]),
    ...caseRows("run-1", "gpt-5-mini", "Add a label", "case-c", [
      "passed",
      "passed",
      "passed",
      "failed",
    ]),
    ...caseRows("run-1", "gpt-5-mini", "Legacy case", undefined, ["pending"]),
  ];

  function renderList(
    matrix = matrixOf(mixed),
    props: Partial<Parameters<typeof RunTestRuns>[0]> = {},
  ) {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    renderWithProviders(
      <RunTestRuns
        rows={matrix.rows}
        targets={matrix.targets}
        passThreshold={0.7}
        onOpen={onOpen}
        onEdit={onEdit}
        {...props}
      />,
    );
    return { onOpen, onEdit };
  }

  it("sorts failed, flaky, running, passed, then by title, with the count", () => {
    renderList();
    expect(titles()).toEqual([
      "Sketch a two-node flow",
      "Add a label",
      "Legacy case",
      "Draw a rectangle",
    ]);
    expect(screen.getByRole("region", { name: "Test runs" })).toHaveTextContent(
      "Test runs4",
    );
  });

  it("labels each cell's verdict and count", () => {
    renderList();
    const [failed, flaky, running, passed] =
      screen.getAllByTestId("test-run-cell");
    expect(failed).toHaveTextContent("Fail1/4");
    expect(failed).toHaveClass("text-destructive");
    expect(flaky).toHaveTextContent("Flaky3/4");
    expect(running).toHaveTextContent("Running0/1");
    expect(passed).toHaveTextContent("Pass2/2");
    expect(screen.getByLabelText("1 of 4 iterations passed")).toBeTruthy();
  });

  it("searches titles and filters by status", async () => {
    const user = userEvent.setup();
    renderList();
    await user.type(
      screen.getByRole("textbox", { name: "Find a test run" }),
      "draw",
    );
    expect(titles()).toEqual(["Draw a rectangle"]);
    await user.clear(screen.getByRole("textbox", { name: "Find a test run" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Flaky" }));
    expect(titles()).toEqual(["Add a label"]);
    await user.type(
      screen.getByRole("textbox", { name: "Find a test run" }),
      "zzz",
    );
    expect(screen.getByText("No test runs match.")).toBeVisible();
  });

  it("opens and edits through the row's buttons, and offers no edit without a case id", async () => {
    const user = userEvent.setup();
    const { onOpen, onEdit } = renderList();
    await user.click(screen.getByRole("button", { name: "Draw a rectangle" }));
    await user.click(
      screen.getByRole("button", { name: "Open test run: Draw a rectangle" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit Test Case: Draw a rectangle" }),
    );
    expect(onOpen.mock.calls).toEqual([["case-a"], ["case-a"]]);
    expect(onEdit).toHaveBeenCalledWith("case-a");
    expect(
      screen.getByRole("button", { name: "Open test run: Legacy case" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Edit Test Case: Legacy case" }),
    ).toBeNull();
    // The sliding label is decoration; the name lives on the button.
    expect(screen.getAllByText("Open test run")[0]).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("names each model in a header row and shows — where a model has no iteration", () => {
    const two = matrixOf(
      [
        ...caseRows("run-1", "gpt-5-mini", "Draw a rectangle", "case-a", [
          "passed",
        ]),
        ...caseRows("run-2", "claude-haiku-4.5", "Draw a rectangle", "case-a", [
          "passed",
        ]),
        ...caseRows("run-2", "claude-haiku-4.5", "Only on Claude", "case-z", [
          "failed",
        ]),
      ],
      ["gpt-5-mini", "claude-haiku-4.5"],
    );
    renderList(two);
    expect(screen.getByText("Test run")).toBeTruthy();
    expect(screen.getByText("gpt-5-mini")).toBeTruthy();
    expect(screen.getByText("claude-haiku-4.5")).toBeTruthy();
    const onlyClaude = screen.getAllByTestId("test-run-row")[0];
    expect(onlyClaude).toHaveTextContent("Only on Claude");
    expect(onlyClaude).toHaveTextContent("—");
  });

  it("has no header row with one model", () => {
    renderList();
    expect(screen.queryByText("Test run")).toBeNull();
  });
});
