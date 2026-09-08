import { describe, expect, it, vi } from "vitest";
import {
  render,
  renderHook,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import type { EvalIteration } from "@/components/evals/types";
import { useSuggestedScorers } from "../case-scorecard/suggested-from-run-section";
import { TrialScorecard } from "../case-scorecard/trial-scorecard";
import { JudgeVerdictPanel } from "@/components/evals/goal-completion-presentation";
import { groupCaseIterations } from "@/components/evals/runs/group-case-iterations";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";

vi.mock("convex/react", () => ({ useAction: () => vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

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

  it("recognizes a frozen gate even after the live draft removes it", () => {
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
      result.current.output.suggestions.some((s) => s.role === "gate"),
    ).toBe(true);
  });

  it("withholds judge-derived totals, chain states and suggestions until reveal", () => {
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
    expect(screen.getByTestId("trial-scorecard-summary")).toHaveTextContent(
      "No scorers ran",
    );
    expect(
      screen.queryByText("Suggestions based on judge success"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("0.93")).not.toBeInTheDocument();
    view.rerender(<TrialScorecard {...props} judgeHidden={false} />);
    expect(screen.getByTestId("stage-strip")).toBeInTheDocument();
    expect(screen.getByTestId("trial-scorecard-summary")).toHaveTextContent(
      "1 of 1 gate passed",
    );
    expect(screen.getByText("0.93")).toBeInTheDocument();
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
