import { render, screen } from "@testing-library/react";
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
