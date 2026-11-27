import { describe, expect, it, vi } from "vitest";
import {
  render,
  renderHook,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import {
  buildEvaluationConfigSnapshot,
  finalizeScoreResult,
  resolveScoreDefinition,
  type ScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { EvalIteration } from "@/components/evals/types";
import { hostedRubricCheckScorerId } from "@/shared/hosted-criterion-id";
import { useSuggestedScorers } from "../case-scorecard/suggested-from-run-section";
import { TrialScorecard } from "../case-scorecard/trial-scorecard";
import {
  JudgeVerdictPanel,
  type JudgeCase,
} from "@/components/evals/goal-completion-presentation";
import { groupCaseIterations } from "@/components/evals/runs/group-case-iterations";
import { computeIterationResult } from "@/components/evals/pass-criteria";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";

vi.mock("convex/react", () => ({ useAction: () => vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const libraryFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" && libraryFlag.enabled,
}));

const steps = [{ id: "p", kind: "prompt" as const, prompt: "Find my account" }];
const authored = {
  steps,
  toolsChoice: "unset" as const,
  expectedOutput: "States the account email",
};
const iteration: EvalIteration = {
  _id: "it1",
  testCaseId: "c1",
  suiteRunId: "run1",
  iterationNumber: 1,
  status: "completed",
  result: "passed",
  tokensUsed: 50,
  createdAt: 1,
  updatedAt: 2,
  createdBy: "u1",
  actualToolCalls: [{ toolName: "wrong_tool", arguments: {} }],
  testCaseSnapshot: {
    title: "T",
    query: "Find my account",
    steps,
    expectedOutput: authored.expectedOutput,
    model: "m",
    provider: "p",
    expectedToolCalls: [],
  },
} as EvalIteration;

describe("scorecard integration regressions", () => {
  it("renders saved custom judges on an iteration without projected scores", () => {
    const savedIteration: EvalIteration = {
      ...iteration,
      resultSource: "reported",
      metadata: {
        customJudgesVerdict: {
          judges: [
            {
              id: "answers-the-question",
              label: "Answers the Question",
              status: "scored",
              passed: true,
              value: 1,
              output: { kind: "passfail" },
            },
            {
              id: "includes-link",
              label: "Includes a Link",
              status: "scored",
              passed: false,
              value: 0.6,
              output: { kind: "score", threshold: 0.8 },
              reason: "No export link in the answer.",
            },
          ],
        },
      },
    };

    const { rerender } = render(
      <TrialScorecard authored={authored} iteration={savedIteration} steps={steps} />,
    );
    const rows = screen.getAllByTestId("trial-scorecard-row");
    for (const [label, state] of [
      ["Answers the Question", "passed"],
      ["Includes a Link", "failed"],
    ] as const) {
      const row = rows.find((candidate) =>
        candidate.textContent?.includes(label),
      );
      expect(row).toHaveAttribute("data-state", state);
      expect(row).toHaveAttribute("data-role", "advisory");
      if (label === "Includes a Link") {
        expect(row).toHaveTextContent("Score of 0.8 or higher");
        expect(row).toHaveTextContent("Score 0.6");
        expect(row).toHaveTextContent("No export link in the answer.");
      }
    }
    expect(computeIterationResult(savedIteration)).toBe("passed");

    // No goal-judge case means no reveal control, so blind review leaves
    // these rows visible instead of hiding them for good.
    rerender(
      <TrialScorecard
        authored={authored}
        iteration={savedIteration}
        steps={steps}
        judgeHidden
      />,
    );
    expect(screen.getByText("Includes a Link")).toBeVisible();

    // With a goal-judge case the reveal control exists, so blind review
    // withholds the custom judge rows with it.
    rerender(
      <TrialScorecard
        authored={authored}
        iteration={savedIteration}
        steps={steps}
        judgeCase={{ score: 0.9, passed: true, reason: "Goal met" }}
        judgeHidden
      />,
    );
    const withheld = screen
      .getAllByTestId("trial-scorecard-row")
      .find((candidate) => candidate.textContent?.includes("Includes a Link"));
    expect(withheld).toHaveTextContent("Hidden");
    expect(withheld).not.toHaveTextContent("No export link in the answer.");

    libraryFlag.enabled = false;
    try {
      rerender(
        <TrialScorecard authored={authored} iteration={savedIteration} steps={steps} />,
      );
      expect(screen.queryByText("Includes a Link")).not.toBeInTheDocument();
      expect(screen.queryByText("Answers the Question")).not.toBeInTheDocument();
    } finally {
      libraryFlag.enabled = true;
    }
  });

  it("does not offer requirements from an unjudged case with zero checks", async () => {
    const batch = groupCaseIterations([iteration])[0];
    const { result } = renderHook(() =>
      useSuggestedScorers({
        enabled: true,
        batch,
        authored,
        prompts: [steps[0].prompt],
      }),
    );
    await waitFor(() => expect(result.current.waiting).toBe(false));
    expect(
      result.current.output.suggestions.filter((s) => s.role === "gate"),
    ).toEqual([]);
    expect(result.current.output.diagnosis?.noSignal).toBe(true);
  });

  it("does not use a newly authored gate as evidence for an older ungated run", () => {
    const batch = groupCaseIterations([iteration])[0];
    const { result } = renderHook(() =>
      useSuggestedScorers({
        enabled: true,
        batch,
        prompts: [steps[0].prompt],
        authored: {
          ...authored,
          predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
        },
      }),
    );
    expect(result.current.output.diagnosis?.noSignal).toBe(true);
    expect(
      result.current.output.suggestions.every((s) => s.role !== "gate"),
    ).toBe(true);
  });

  it("recognizes a frozen required rule even after the live draft removes it", () => {
    const batch = groupCaseIterations([
      {
        ...iteration,
        testCaseSnapshot: {
          ...iteration.testCaseSnapshot!,
          predicates: [{ type: "noToolErrors" }],
        },
      },
    ])[0];
    const { result } = renderHook(() =>
      useSuggestedScorers({
        enabled: true,
        batch,
        authored,
        prompts: [steps[0].prompt],
      }),
    );
    expect(result.current.output.diagnosis).toBeNull();
    expect(
      result.current.output.suggestions.some((s) => s.role === "required"),
    ).toBe(true);
  });

  it("withholds judge-derived totals, chain states and suggestions until reveal", async () => {
    const props = {
      authored: {
        ...authored,
        suiteJudgeConfig: { goalCompletion: { role: "gating" as const } },
      },
      iteration,
      steps,
      judgeCase: { score: 0.93, passed: true, reason: "Judge-only rationale" },
      chain: {
        status: "verified",
        stages: [{ stage: "userValue", state: "passed" }],
      } as any,
      suggestionsSlot: <span>Suggestions based on judge success</span>,
    };
    const view = render(<TrialScorecard {...props} judgeHidden />);
    expect(screen.queryByTestId("stage-strip")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Suggestions based on judge success"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("0.93")).not.toBeInTheDocument();
    expect(screen.queryByText("Judge-only rationale")).not.toBeInTheDocument();
    view.rerender(<TrialScorecard {...props} judgeHidden={false} />);
    const userValue = document.querySelector('[data-stage-group="userValue"]');
    expect(
      userValue?.querySelector('[data-testid="scorecard-group-state"]'),
    ).toHaveTextContent("passed");
    const judgeRow = screen
      .getAllByTestId("trial-scorecard-row")
      .find((row) => row.getAttribute("data-row-key") === "judge:goalCompletion");
    expect(judgeRow).toBeDefined();
    expect(judgeRow).toHaveTextContent("Judge-only rationale");
  });

  it("hides judge results until the reviewer reveals them", () => {
    const judgeCase = {
      score: 0.93,
      passed: true,
      reason: "Judge-only rationale",
    } as any;
    const onReview = vi.fn();
    render(
      <TrialScorecard
        authored={authored}
        iteration={iteration}
        steps={steps}
        judgeCase={judgeCase}
        judgeHidden
        judgeSlot={
          <JudgeVerdictPanel
            judgeCase={judgeCase}
            review={null}
            onReview={onReview}
          />
        }
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reveal judge verdict" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "pass", exact: true }));
    expect(onReview).toHaveBeenCalledWith("pass", { blind: true });
    expect(screen.queryByText("0.93")).not.toBeInTheDocument();
  });

  /** A trial graded on one projected yes/no question, as the server stores it. */
  function gradedOnQuestion(question: {
    id: string;
    label: string;
    pYes: number;
    passOn: "yes" | "no";
    rationale: string;
  }): EvalIteration {
    const key = `q:${question.id}`;
    const value = question.passOn === "no" ? 1 - question.pYes : question.pYes;
    const definition: ScoreDefinition = {
      scorerId: hostedRubricCheckScorerId(key),
      idSource: "platform",
      scorerVersion: "1",
      implementationHash: `impl-${key}`,
      label: `rubric check: ${question.label}`,
      deterministic: false,
      passThreshold: 0.5,
      role: "advisory",
      model: "typesafe-ai/jev",
    };
    return {
      ...iteration,
      metadata: {
        evaluationConfig: buildEvaluationConfigSnapshot([definition]),
        scores: [
          finalizeScoreResult(resolveScoreDefinition(definition), {
            kind: "scored",
            value,
            rationale: question.rationale,
          }),
        ],
        rubricChecksVerdict: {
          questions: [
            {
              key,
              kind: "boolean",
              label: question.label,
              contentDigest: "d",
              passThreshold: 0.5,
              status: "scored",
              value,
              probability: question.pYes,
              rationale: question.rationale,
            },
          ],
        },
      },
    };
  }

  it("withholds a library question's verdict in blind review", () => {
    const judgeCase: Partial<JudgeCase> = {
      score: 0.93,
      passed: true,
      reason: "Judge",
    };
    const id = "reports-tool-errors-reports-failures";
    const props = {
      authored: {
        ...authored,
        suiteJudgeConfig: {
          rubricChecks: {
            questions: [
              {
                id,
                kind: "yesno" as const,
                label: "Answer reports each tool error",
                instructions: "Check each error.",
                pass: { answer: "yes" as const },
                evaluator: { id: "reports-tool-errors", version: 1 },
              },
            ],
          },
        },
      },
      iteration: gradedOnQuestion({
        id,
        label: "Answer reports each tool error",
        pYes: 0.02,
        passOn: "yes",
        rationale: "Invented a refund amount",
      }),
      steps,
      judgeCase: judgeCase as JudgeCase,
    };
    const view = render(<TrialScorecard {...props} judgeHidden />);
    expect(
      screen.queryByRole("region", { name: "Library evaluators" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Invented a refund amount/)).toBeNull();
    view.rerender(<TrialScorecard {...props} judgeHidden={false} />);
    expect(
      screen.getByRole("region", { name: "Library evaluators" }),
    ).toHaveTextContent(/failed/i);
  });

  it("renders a question that passes on No as Passed on a clear No, Uncertain near even odds", () => {
    const question = {
      id: "invented-result",
      label: "Presents a result no tool returned",
      passOn: "no" as const,
    };
    const rowFor = () =>
      screen
        .getAllByTestId("trial-scorecard-row")
        .find(
          (row) =>
            row.getAttribute("data-row-key") ===
            hostedRubricCheckScorerId(`q:${question.id}`),
        );
    const view = render(
      <TrialScorecard
        authored={authored}
        iteration={gradedOnQuestion({
          ...question,
          pYes: 0.1,
          rationale: "No · P(yes) 0.10",
        })}
        steps={steps}
      />,
    );
    expect(rowFor()).toHaveTextContent("Presents a result no tool returned");
    expect(rowFor()).toHaveTextContent("Passed");
    expect(rowFor()).toHaveTextContent("No · P(yes) 0.10");
    expect(rowFor()).not.toHaveTextContent(/uncertain/i);
    view.rerender(
      <TrialScorecard
        authored={authored}
        iteration={gradedOnQuestion({
          ...question,
          pYes: 0.45,
          rationale: "No · P(yes) 0.45",
        })}
        steps={steps}
      />,
    );
    expect(rowFor()).toHaveTextContent("Uncertain");
    expect(rowFor()).not.toHaveTextContent("Passed");
    expect(rowFor()).toHaveTextContent("No · P(yes) 0.45");
  });

  it("uses a historical no-tool route instead of the current tools choice", () => {
    const past = {
      ...iteration,
      actualToolCalls: [],
      testCaseSnapshot: {
        ...iteration.testCaseSnapshot,
        steps,
        isNegativeTest: true,
      },
    };
    const frozen = authoredForTrial({
      trial: { kind: "persisted", source: "history", iteration: past } as any,
      draft: authored,
      run: null,
      forceSnapshot: true,
    });
    expect(buildCaseScorecard(frozen.authored).route.route?.kind).toBe(
      "noTool",
    );
  });
});
