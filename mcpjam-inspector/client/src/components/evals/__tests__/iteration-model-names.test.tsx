import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelDisplayNamesContext } from "@/lib/model-display-name";
import { CompactIterationRow } from "../iteration-row";
import { TestCaseIterationsTable } from "../test-case-iterations-table";
import type { EvalCase, EvalIteration } from "../types";

vi.mock("../iteration-details", () => ({ IterationDetails: () => null }));

const models = [
  { id: "first/shared", name: "First model" },
  { id: "second/shared", name: "Second model" },
];
const testCase = {
  title: "Example",
  models: [{ provider: "first", model: "shared" }],
} as EvalCase;
const iteration = {
  _id: "iteration",
  result: "passed",
  createdAt: Date.now(),
  testCaseSnapshot: { provider: "second", model: "shared" },
} as EvalIteration;

function compact(value: EvalIteration, fallback: EvalCase | null = testCase) {
  return render(
    <ModelDisplayNamesContext.Provider value={models}>
      <CompactIterationRow
        iteration={value}
        testCase={testCase}
        iterationTestCase={fallback}
        formatTime={() => ""}
        formatDuration={() => ""}
      />
    </ModelDisplayNamesContext.Provider>,
  );
}

describe("iteration model labels", () => {
  it("uses the snapshot provider before the case model", () => {
    compact(iteration);
    expect(screen.getByText("Second model")).toBeInTheDocument();
    expect(screen.queryByText("First model")).not.toBeInTheDocument();
  });
  it("uses the case provider when no snapshot model exists", () => {
    compact({ ...iteration, testCaseSnapshot: undefined });
    expect(screen.getByText("First model")).toBeInTheDocument();
  });
  it("keeps the empty model fallback", () => {
    compact({ ...iteration, testCaseSnapshot: undefined }, null);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
  it("uses the snapshot provider in the iterations table", () => {
    render(
      <ModelDisplayNamesContext.Provider value={models}>
        <TestCaseIterationsTable testCase={testCase} iterations={[iteration]} />
      </ModelDisplayNamesContext.Provider>,
    );
    expect(screen.getByText("Second model")).toBeInTheDocument();
  });
});

describe("iterations table targets (model × effort)", () => {
  const ran = (
    id: string,
    effort: string | undefined,
    usage: EvalIteration["usage"],
  ) =>
    ({
      ...iteration,
      _id: id,
      tokensUsed: 100,
      actualToolCalls: [],
      usage,
      ...(effort
        ? { execution: { effectiveSettings: { reasoningEffort: effort } } }
        : {}),
    }) as EvalIteration;

  it("labels each row with its effort and shows its reasoning tokens", () => {
    render(
      <ModelDisplayNamesContext.Provider value={models}>
        <TestCaseIterationsTable
          testCase={testCase}
          iterations={[
            ran("a", "high", { reasoningTokens: 1234, estimatedCostUsd: 0.02 }),
          ]}
        />
      </ModelDisplayNamesContext.Provider>,
    );
    expect(screen.getByText("Second model · High")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    // A single target needs no per-target summary.
    expect(screen.queryByTestId("iteration-target-summary")).toBeNull();
  });

  it("summarizes effort, cost and reasoning per target when rows span several", () => {
    render(
      <ModelDisplayNamesContext.Provider value={models}>
        <TestCaseIterationsTable
          testCase={testCase}
          iterations={[
            ran("a", "high", { reasoningTokens: 300, estimatedCostUsd: 0.5 }),
            ran("b", "high", { reasoningTokens: 200, estimatedCostUsd: 0.25 }),
            ran("c", undefined, {}),
          ]}
        />
      </ModelDisplayNamesContext.Provider>,
    );
    const targets = within(
      screen.getByTestId("iteration-target-summary"),
    ).getAllByTestId("iteration-target");
    expect(targets).toHaveLength(2);
    expect(targets[0]).toHaveTextContent(/^Second model · High/);
    expect(targets[0]).toHaveTextContent(/2\/2 passed/);
    expect(targets[0]).toHaveTextContent(/\$0\.75/);
    expect(targets[0]).toHaveTextContent(/500 reasoning/);
    // Ran with no effort: no effort label, no cost observed, no reasoning.
    expect(targets[1]).not.toHaveTextContent(/·.*High/);
    expect(targets[1]).not.toHaveTextContent(/reasoning/);
  });
});
