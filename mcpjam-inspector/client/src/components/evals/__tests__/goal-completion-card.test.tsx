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
    // Default the snapshot to a configured judge so the card renders the
    // run controls path (the configured behavior). Tests that want the
    // unconfigured CTA pass a run override with `judgeConfig: undefined`.
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
      judgeConfig: { goalCompletion: { enabled: true } },
    },
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
  it("offers a Run judge control before any run", () => {
    render(<GoalCompletionCard {...baseProps} onRun={vi.fn()} />);
    expect(screen.getByText("LLM as Judge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run judge/i })).toBeEnabled();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
  });

  it("runs the judge against the suite config (no override) by default", async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    render(<GoalCompletionCard {...baseProps} onRun={onRun} />);

    await user.click(screen.getByRole("button", { name: /Run judge/i }));

    // V2 semantic: when the card's inputs equal the suite-configured values
    // (here both fall back to managed defaults), `runOverride` is undefined
    // and the backend explicitly clears any previously persisted run
    // override. This is the "re-running without re-confirming exploration
    // returns to the suite contract" property the plan requires.
    expect(onRun).toHaveBeenCalledWith({ runOverride: undefined }, false);
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
      screen.getByText(/Grading final answers/i),
    ).toBeInTheDocument();
  });

  it("disables running once a request is in flight (no duplicate judge calls)", () => {
    // After a click, `requested` is true before the run doc flips to pending;
    // the button must already be disabled so a second click can't double-spend.
    render(<GoalCompletionCard {...baseProps} requested onRun={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Run judge/i })).toBeDisabled();
  });

  it("shows a grading state (not stale scores) during a re-run gap", () => {
    // requested=true with a prior result still on the run: the card must show
    // the in-flight state rather than the previous run's scores as if current.
    const goalCompletion: EvalSuiteRun["goalCompletion"] = {
      summary: "prior run",
      generatedAt: 1,
      modelUsed: "openai/gpt-5.4-mini",
      threshold: 0.7,
      cases: [
        {
          caseKey: "ck-1",
          score: 0.8,
          passed: true,
          reason: "old reason",
          rubricHits: [],
        },
      ],
    };
    render(
      <GoalCompletionCard
        {...baseProps}
        requested
        goalCompletion={goalCompletion}
        onRun={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Grading final answers/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Requesting…")).toBeInTheDocument();
    // Stale score / reason from the previous run must not be displayed.
    expect(screen.queryByText("80%")).not.toBeInTheDocument();
    expect(screen.queryByText("old reason")).not.toBeInTheDocument();
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
    expect(onRun).toHaveBeenCalledWith({ runOverride: undefined }, true);
  });

  it("shows run controls by default when the snapshot has no explicit enable", () => {
    // Default-on semantics matching GOAL_COMPLETION_DEFAULTS (`enabled: true`):
    // an unconfigured snapshot resolves to enabled and surfaces controls.
    // Cost is gated by autoRun: false + the explicit click.
    const unconfiguredRun = makeRun({
      configSnapshot: { tests: [], environment: { servers: [] } },
    });
    render(
      <GoalCompletionCard
        {...baseProps}
        run={unconfiguredRun}
        onRun={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Run judge/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/Disabled in suite settings/i),
    ).not.toBeInTheDocument();
  });

  it("hides run controls when the snapshot explicitly disabled the judge", () => {
    const disabledRun = makeRun({
      configSnapshot: {
        tests: [],
        environment: { servers: [] },
        judgeConfig: { goalCompletion: { enabled: false } },
      },
    });
    render(
      <GoalCompletionCard {...baseProps} run={disabledRun} onRun={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: /Run judge/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Disabled in suite settings/i),
    ).toBeInTheDocument();
  });

  it("re-enables run controls when the current suite is enabled, even if the snapshot disabled it", () => {
    // Real-world fix: user ran a suite when the judge was off, then
    // enabled it later. The snapshot says off, but currentSuiteJudgeConfig
    // says on — let the user trigger a re-run instead of locking them out.
    const oldRun = makeRun({
      configSnapshot: {
        tests: [],
        environment: { servers: [] },
        judgeConfig: { goalCompletion: { enabled: false } },
      },
    });
    render(
      <GoalCompletionCard
        {...baseProps}
        run={oldRun}
        onRun={vi.fn()}
        currentSuiteJudgeConfig={{ goalCompletion: { enabled: true } }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Run judge/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/Disabled in suite settings/i),
    ).not.toBeInTheDocument();
  });

  it("renders a prominent override banner when the run carries a judge override", () => {
    const runWithOverride = makeRun({
      configSnapshot: {
        tests: [],
        environment: { servers: [] },
        judgeConfig: {
          goalCompletion: {
            enabled: true,
            judgeModel: "openai/gpt-5.4-mini",
            threshold: 0.7,
          },
        },
      },
      judgeConfigOverride: {
        goalCompletion: { threshold: 0.85 },
      },
    });
    render(
      <GoalCompletionCard
        {...baseProps}
        run={runWithOverride}
        onRun={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/This run used an override/i),
    ).toBeInTheDocument();
    // Suite default + run override are shown side-by-side so the user
    // sees why this run's scores aren't suite-contract calibrated.
    expect(screen.getByText(/Suite default:/)).toBeInTheDocument();
    expect(
      screen.getByText(/openai\/gpt-5\.4-mini @ 0\.7/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/openai\/gpt-5\.4-mini @ 0\.85/),
    ).toBeInTheDocument();
  });
});
