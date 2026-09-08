import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrialHeader } from "../case-workspace/trial-header";
import type { EvalIteration } from "../../evals/types";

function iteration(id: string, result: EvalIteration["result"]): EvalIteration {
  return {
    _id: id,
    testCaseId: "case-1",
    createdBy: "u",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 1,
    status: result === "pending" ? "running" : "completed",
    result,
    actualToolCalls: [],
    tokensUsed: 0,
  };
}

describe("TrialHeader", () => {
  it("renders the deterministic verdict and never invents Grading on a quick run", () => {
    render(
      <TrialHeader
        trial={{
          kind: "persisted",
          iteration: iteration("it-1", "passed"),
          source: "latest",
        }}
        iterations={[iteration("it-1", "passed")]}
        onSelectIteration={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("case-workspace-trial-verdict"),
    ).toHaveTextContent("Passed");
    expect(
      screen.queryByTestId("case-workspace-trial-activity"),
    ).not.toBeInTheDocument();
  });

  it("shows Grading only with run context", () => {
    render(
      <TrialHeader
        trial={{
          kind: "persisted",
          iteration: iteration("it-1", "passed"),
          source: "history",
        }}
        run={{ status: "grading" }}
        iterations={[iteration("it-1", "passed")]}
        onSelectIteration={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("case-workspace-trial-activity"),
    ).toHaveTextContent("Grading");
  });

  it("counts completed trials in the newest batch only", () => {
    const older = (id: string, createdAt: number) => ({
      ...iteration(id, "passed"),
      createdAt,
      metadata: { compareRunId: "batch-a" },
    });
    const newest = {
      ...iteration("it-3", "failed"),
      createdAt: 30,
      metadata: { compareRunId: "batch-b" },
    };
    render(
      <TrialHeader
        trial={{ kind: "persisted", iteration: newest, source: "latest" }}
        iterations={[older("it-1", 10), older("it-2", 20), newest]}
        onSelectIteration={vi.fn()}
      />,
    );
    expect(screen.getByText("1 trial complete")).toBeInTheDocument();
  });

  it("opens History and reports the pick", async () => {
    const user = userEvent.setup();
    const onSelectIteration = vi.fn();
    const second = { ...iteration("it-2", "failed"), iterationNumber: 2 };
    render(
      <TrialHeader
        trial={{
          kind: "persisted",
          iteration: iteration("it-1", "passed"),
          source: "latest",
        }}
        iterations={[iteration("it-1", "passed"), second]}
        onSelectIteration={onSelectIteration}
      />,
    );
    await user.click(screen.getByTestId("case-workspace-history"));
    expect(onSelectIteration).not.toHaveBeenCalled();
  });
});
