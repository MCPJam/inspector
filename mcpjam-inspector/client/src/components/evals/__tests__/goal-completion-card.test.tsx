import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalCompletionCard } from "../goal-completion-card";
import type { EvalIteration, EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    ...overrides,
  };
}

function makeIteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "iter-1",
    createdBy: "user",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 2,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    testCaseSnapshot: {
      caseKey: "ck-1",
      title: "Weather lookup",
      query: "q",
      provider: "openai",
      model: "gpt",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const baseProps = {
  run: makeRun(),
  iterations: [makeIteration()],
  goalCompletion: null,
  availableModels: [],
  pending: false,
  requested: false,
  failedGeneration: false,
  error: null,
  onRun: vi.fn(),
};

describe("GoalCompletionCard", () => {
  it("labels itself advisory and offers a Run judge control before any run", () => {
    render(<GoalCompletionCard {...baseProps} onRun={vi.fn()} />);
    expect(screen.getByText("Goal completion")).toBeInTheDocument();
    expect(screen.getByText(/advisory · LLM judge/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run judge/i })).toBeEnabled();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
  });

  it("runs the judge with the selected default model and threshold", async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    render(<GoalCompletionCard {...baseProps} onRun={onRun} />);

    await user.click(screen.getByRole("button", { name: /Run judge/i }));

    expect(onRun).toHaveBeenCalledWith(
      { judgeModel: "openai/gpt-5.4-mini", threshold: 0.7 },
      false,
    );
  });

  it("renders per-case score, advisory verdict and reason once graded", () => {
    const goalCompletion: EvalSuiteRun["goalCompletion"] = {
      summary: "One case met the goal, one fell short.",
      generatedAt: 1,
      modelUsed: "openai/gpt-5.4-mini",
      threshold: 0.7,
      cases: [
        {
          caseKey: "ck-1",
          score: 0.8,
          passed: true,
          reason: "Final answer returned the forecast.",
          rubricHits: ["returned the forecast"],
        },
        {
          caseKey: "ck-2",
          score: 0.3,
          passed: false,
          reason: "Final answer omitted the temperature.",
          rubricHits: ["missing: temperature"],
        },
      ],
    };
    render(
      <GoalCompletionCard
        {...baseProps}
        goalCompletion={goalCompletion}
        onRun={vi.fn()}
      />,
    );

    // Joins caseKey -> human title from the iterations.
    expect(screen.getByText("Weather lookup")).toBeInTheDocument();
    // ck-2 has no matching iteration, so it falls back to the caseKey itself.
    expect(screen.getByText("ck-2")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("meets goal")).toBeInTheDocument();
    expect(screen.getByText("below threshold")).toBeInTheDocument();
    expect(
      screen.getByText("Final answer returned the forecast."),
    ).toBeInTheDocument();
    // Advisory framing is explicit.
    expect(
      screen.getByText(/Advisory only — the deterministic/i),
    ).toBeInTheDocument();
    // Re-run is offered once a result exists.
    expect(
      screen.getByRole("button", { name: /Re-run judge/i }),
    ).toBeInTheDocument();
  });

  it("disables running while a grade is pending", () => {
    render(<GoalCompletionCard {...baseProps} pending onRun={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Run judge/i })).toBeDisabled();
    expect(
      screen.getByText(/Grading final answers against expected output/i),
    ).toBeInTheDocument();
  });

  it("disables running once a request is in flight (no duplicate judge calls)", () => {
    // After a click, `requested` is true before the run doc flips to pending;
    // the button must already be disabled so a second click can't double-spend.
    render(<GoalCompletionCard {...baseProps} requested onRun={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Run judge/i })).toBeDisabled();
  });

  it("forces a re-request when retrying a failed run", async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    // Failed with no stored result: the main control must still pass force.
    render(
      <GoalCompletionCard
        {...baseProps}
        failedGeneration
        goalCompletion={null}
        onRun={onRun}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Run judge/i }));
    expect(onRun).toHaveBeenCalledWith(
      { judgeModel: "openai/gpt-5.4-mini", threshold: 0.7 },
      true,
    );
  });
});
