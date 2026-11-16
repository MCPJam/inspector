import type { ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import type { IterationDetails } from "../../../evals/iteration-details";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import { IterationReport } from "../iteration-report";

const selected = vi.hoisted(() => ({ run: null as EvalSuiteRun | null }));
vi.mock("../../../evals/use-selected-run", () => ({
  useSelectedRun: () => selected,
}));
vi.mock("../../../evals/iteration-details", () => ({
  IterationDetails: ({ scorecard }: ComponentProps<typeof IterationDetails>) =>
    scorecard?.render({
      envelope: null,
      trace: null,
      envelopeLoading: false,
      reviewActive: false,
      judgeHidden: false,
      onJudgeVisibilityChange: vi.fn(),
      scoresSection: null,
    }),
}));
vi.mock("../../case-scorecard/iteration-report-subscriber", async () => {
  const { TrialScorecard } =
    await import("../../case-scorecard/trial-scorecard");
  return { IterationReportScorecard: TrialScorecard };
});

const iteration: EvalIteration = {
  _id: "iteration-2",
  suiteRunId: "run",
  createdBy: "user",
  createdAt: 1,
  updatedAt: 2,
  iterationNumber: 2,
  status: "completed",
  result: "passed",
  actualToolCalls: [],
  tokensUsed: 0,
  testCaseSnapshot: {
    caseKey: "addition",
    title: "Addition",
    query: "Add 17 and 25",
    provider: "openai",
    model: "gpt-5.1",
    expectedToolCalls: [],
    expectedOutput: "Report the returned sum.",
  },
};
const run: EvalSuiteRun = {
  _id: "run",
  suiteId: "suite",
  createdBy: "user",
  createdAt: 1,
  runNumber: 18,
  configRevision: "revision",
  configSnapshot: { tests: [] },
  status: "completed",
  goalCompletion: {
    summary: "Complete",
    generatedAt: 2,
    modelUsed: "judge",
    threshold: 0.7,
    cases: [
      {
        caseKey: "addition",
        iterationId: "iteration-1",
        score: 0,
        passed: false,
        reason: "Wrong sibling result",
        rubricHits: [],
      },
      {
        caseKey: "addition",
        iterationId: "iteration-2",
        score: 1,
        passed: true,
        reason: "Reported the tool-provided 42.",
        rubricHits: [],
      },
    ],
  },
};

function openReport() {
  const target = buildRunResultsMatrix({
    run,
    runs: [],
    iterations: [iteration],
    hostNamesById: new Map(),
  }).targets[0]!;
  render(<IterationReport iteration={iteration} target={target} />);
  return within(
    screen
      .getAllByTestId("trial-scorecard-row")
      .find((row) => row.textContent?.includes("Outcome achieved"))!,
  );
}

beforeEach(() => {
  selected.run = run;
});

it("shows the selected iteration's judge result without score rows", () => {
  const outcome = openReport();
  expect(outcome.getByText("Reported the tool-provided 42.")).toBeVisible();
  expect(outcome.queryByText("Wrong sibling result")).not.toBeInTheDocument();
  expect(
    outcome.queryByText("No observation recorded."),
  ).not.toBeInTheDocument();
});

it("does not borrow a sibling verdict when this iteration was not judged", () => {
  selected.run = {
    ...run,
    goalCompletion: {
      ...run.goalCompletion!,
      cases: [run.goalCompletion!.cases[0]!],
    },
  };
  const outcome = openReport();
  expect(outcome.getByText("No observation recorded.")).toBeVisible();
  expect(outcome.queryByText("Wrong sibling result")).not.toBeInTheDocument();
});

it("leaves the result unmeasured while the selected run is loading", () => {
  selected.run = null;
  const outcome = openReport();
  expect(outcome.getByText("No observation recorded.")).toBeVisible();
});
