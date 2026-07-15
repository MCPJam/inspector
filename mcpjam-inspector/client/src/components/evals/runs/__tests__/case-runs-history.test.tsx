import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CaseRunsHistory } from "../case-runs-history";
import type { EvalIteration, EvalSuiteRun } from "../../types";

function iteration(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    iterationNumber: 1,
    status: "failed",
    result: "failed",
    actualToolCalls: [],
    tokensUsed: 0,
    createdBy: "user",
    ...partial,
  } as EvalIteration;
}

describe("CaseRunsHistory", () => {
  it("shows the host chip on suite run batches", () => {
    const iterations = [
      iteration({
        _id: "it-a",
        suiteRunId: "run-9",
        trigger: "suite",
      }),
    ];
    const suiteRuns = [
      {
        _id: "run-9",
        suiteId: "suite-1",
        createdBy: "user",
        runNumber: 1,
        configRevision: "rev",
        configSnapshot: { tests: [], environment: { servers: [] } },
        status: "completed",
        result: "failed",
        createdAt: Date.now(),
        namedHostId: "host-chatgpt",
      } satisfies EvalSuiteRun,
    ];

    render(
      <CaseRunsHistory
        iterations={iterations}
        onSelectIteration={() => {}}
        suiteRuns={suiteRuns}
        hostNamesById={new Map([["host-chatgpt", "ChatGPT"]])}
        hasHostAttachments
      />,
    );

    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
  });
});
