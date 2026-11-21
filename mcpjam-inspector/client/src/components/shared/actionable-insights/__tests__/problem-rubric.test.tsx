import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { ProblemRubric } from "../problem-rubric";
import type { AffectedIterationRow } from "../affected-iterations-list";

function row(id: string, chain?: EvalRunDecisionChain): AffectedIterationRow {
  return {
    iterationId: id,
    caseTitle: "Arithmetic",
    iterationNumber: 1,
    client: null,
    model: null,
    result: "failed",
    canOpen: true,
    chain,
  };
}

function failed(stage: UserValueStage): EvalRunDecisionChain {
  return {
    status: "verified",
    analyzerVersion: 11,
    firstFailedStage: stage,
    stages: USER_VALUE_STAGES.map((name, index) => ({
      stage: name,
      state:
        name === stage
          ? "failed"
          : index < USER_VALUE_STAGES.indexOf(stage)
            ? "passed"
            : "notReached",
    })),
  };
}

const problem = {
  iterationIds: ["a", "b"],
  affected: { count: 2, total: 2, unit: "iterations" as const },
};

it("ties the finding to the measured stage and its canonical success rubric", () => {
  render(
    <ul>
      <ProblemRubric
        problem={problem}
        iterationRows={{
          a: row("a", failed("response")),
          b: row("b", failed("response")),
        }}
      />
    </ul>,
  );
  expect(screen.getByText(/Response failed first in 2 of 2/)).toBeVisible();
  expect(screen.getByText(/Usable response returned/)).toBeVisible();
});

it("keeps missing and rejected chains out of stage claims", () => {
  render(
    <ul>
      <ProblemRubric
        problem={problem}
        iterationRows={{ a: row("a", { status: "unverified" }), b: row("b") }}
      />
    </ul>,
  );
  expect(screen.getByText(/Failure stage not established/)).toBeVisible();
  expect(screen.queryByText("Expected:")).toBeNull();
});

it("discloses partial coverage and never borrows another iteration's chain", () => {
  render(
    <ul>
      <ProblemRubric
        problem={problem}
        iterationRows={{
          a: row("a", failed("response")),
          other: row("other", failed("connection")),
        }}
      />
    </ul>,
  );
  expect(screen.getByText(/Response failed first in 1 of 2/)).toHaveTextContent(
    "Failure stage unconfirmed for 1",
  );
  expect(screen.queryByText(/Connection failed/)).toBeNull();
});

it("lists mixed stages in chain order without implying one common failure", () => {
  render(
    <ul>
      <ProblemRubric
        problem={problem}
        iterationRows={{
          a: row("a", failed("response")),
          b: row("b", failed("selection")),
        }}
      />
    </ul>,
  );
  expect(screen.getByText(/Selection failed/)).toHaveTextContent(
    "Selection failed first in 1 of 2 affected iterations; Response failed first in 1 of 2 affected iterations",
  );
  expect(screen.queryByText("Expected:")).toBeNull();
});

it("uses the singular for one affected iteration", () => {
  render(
    <ul>
      <ProblemRubric
        problem={{
          ...problem,
          affected: { ...problem.affected, count: 1 },
        }}
        iterationRows={{ a: row("a", failed("response")) }}
      />
    </ul>,
  );
  expect(screen.getByText(/Response failed first/)).toHaveTextContent(
    "Response failed first in 1 of 1 affected iteration",
  );
});
