import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import {
  EvaluatorScorecardSummary,
  evaluatorIdForQuestionKey,
  evaluatorStatus,
  type SummaryRow,
} from "../evaluator-scorecard-summary";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : undefined,
}));

const wasted = { id: "no-wasted-calls", version: 1 };
const rows: SummaryRow[] = [
  {
    key: "a",
    label: "Fewer than 10 tool calls",
    role: "required",
    predicate: { type: "toolCallCountUnder", count: 10, evaluator: wasted },
    result: { state: "failed", source: "predicateResult", reason: "12 calls" },
  },
  {
    key: "b",
    label: "No identical call repeated back-to-back",
    role: "required",
    predicate: { type: "noRepeatedIdenticalCall", evaluator: wasted },
    result: { state: "passed", source: "predicateResult" },
  },
  {
    key: "c",
    label: "No tool errors",
    role: "required",
    predicate: { type: "noToolErrors" },
    result: { state: "passed", source: "predicateResult" },
  },
];

describe("evaluatorStatus", () => {
  it("lets an error outrank a failure and ignores advisory misses", () => {
    expect(
      evaluatorStatus([
        { role: "required", status: "failed" },
        { role: "required", status: "error" },
      ]),
    ).toBe("error");
    expect(
      evaluatorStatus([
        { role: "advisory", status: "failed" },
        { role: "required", status: "passed" },
      ]),
    ).toBe("passed");
    expect(
      evaluatorStatus([{ role: "required", status: "not_applicable" }]),
    ).toBe("not_applicable");
    expect(
      evaluatorStatus([
        { role: "advisory", status: "failed" },
        { role: "advisory", status: "passed" },
      ]),
    ).toBe("failed");
  });

  it("never lends a Not applicable Required check's pass to an Advisory miss", () => {
    expect(
      evaluatorStatus([
        { role: "required", status: "not_applicable" },
        { role: "advisory", status: "failed" },
      ]),
    ).toBe("failed");
    expect(
      evaluatorStatus([
        { role: "required", status: "not_applicable" },
        { role: "advisory", status: "passed" },
      ]),
    ).toBe("passed");
  });

  it("keeps a required failure when an advisory check errors", () => {
    expect(evaluatorStatus([
      { role: "required", status: "failed" },
      { role: "advisory", status: "error" },
    ])).toBe("failed");
  });
});

describe("EvaluatorScorecardSummary", () => {
  it("shows one card per library evaluator and leaves hand-written checks out", () => {
    renderWithProviders(<EvaluatorScorecardSummary rows={rows} />);
    const card = screen.getByRole("region", { name: "No Wasted Calls" });
    expect(card).toHaveTextContent("Failed");
    expect(card).toHaveTextContent("12 calls");
    expect(card).not.toHaveTextContent("No tool errors");
  });

  const reportsId = "reports-tool-errors-reports-failures";
  const question: RubricCheckQuestion = {
    id: reportsId,
    kind: "yesno",
    label: "Answer reports each tool error",
    instructions: "Check each error.",
    pass: { answer: "yes" },
  };
  const questionRow: SummaryRow = {
    key: `judge:rubricChecks:q:${reportsId}`,
    label: "Answer reports each tool error",
    role: "advisory",
    rubricCheck: { key: `q:${reportsId}` },
    result: {
      state: "passed",
      source: "scoreRow",
      reason: "Yes · P(yes) 0.97",
    },
  };

  it("groups a yes/no question row under the evaluator its question is tagged with", () => {
    renderWithProviders(
      <EvaluatorScorecardSummary
        rows={[questionRow]}
        questions={[
          { ...question, evaluator: { id: "reports-tool-errors", version: 1 } },
        ]}
      />,
    );
    const card = screen.getByRole("region", { name: "Reports Tool Errors" });
    expect(card).toHaveTextContent("Passed");
  });

  it("groups a judge only when its recorded origin is the library evaluator", () => {
    const judge = {
      key: "judge:custom:answers-the-question-answers",
      label: "Answers what the user asked",
      role: "advisory",
      result: { state: "failed", source: "scoreRow", reason: "Off topic." },
    } as const;
    const { rerender } = renderWithProviders(
      <EvaluatorScorecardSummary
        rows={[
          {
            ...judge,
            customJudge: {},
          },
        ]}
      />,
    );
    expect(screen.queryByRole("region", { name: "Answers the Question" }))
      .not.toBeInTheDocument();
    rerender(
      <EvaluatorScorecardSummary
        rows={[
          {
            ...judge,
            customJudge: { evaluatorId: "answers-the-question" },
          },
        ]}
      />,
    );
    const card = screen.getByRole("region", { name: "Answers the Question" });
    expect(card).toHaveTextContent("Failed");
  });

  it("leaves out an untagged question whose id matches a library question", () => {
    const { container } = renderWithProviders(
      <EvaluatorScorecardSummary rows={[questionRow]} questions={[question]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("maps a rubric-check key to an evaluator only through the question's tag", () => {
    const tagged = {
      ...question,
      evaluator: { id: "reports-tool-errors", version: 1 },
    };
    expect(evaluatorIdForQuestionKey(`q:${reportsId}`, [tagged])).toBe(
      "reports-tool-errors",
    );
    expect(
      evaluatorIdForQuestionKey(`q:${reportsId}`, [question]),
    ).toBeUndefined();
    expect(evaluatorIdForQuestionKey(`q:${reportsId}`, [])).toBeUndefined();
    expect(
      evaluatorIdForQuestionKey(`q:${reportsId}`, [
        { ...question, evaluator: { id: "not-in-library", version: 1 } },
      ]),
    ).toBeUndefined();
    expect(evaluatorIdForQuestionKey("c:criterion", [tagged])).toBeUndefined();
  });

  it("renders nothing with the flag off or no library checks", () => {
    flag.on = false;
    const { container, rerender } = renderWithProviders(
      <EvaluatorScorecardSummary rows={rows} />,
    );
    expect(container).toBeEmptyDOMElement();
    flag.on = true;
    rerender(<EvaluatorScorecardSummary rows={[rows[2]]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
