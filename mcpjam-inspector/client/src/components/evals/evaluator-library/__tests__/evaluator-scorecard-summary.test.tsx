import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import {
  EvaluatorScorecardSummary,
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
});

describe("EvaluatorScorecardSummary", () => {
  it("shows one card per library evaluator and leaves hand-written checks out", () => {
    renderWithProviders(<EvaluatorScorecardSummary rows={rows} />);
    const card = screen.getByRole("region", { name: "No Wasted Calls" });
    expect(card).toHaveTextContent("Failed");
    expect(card).toHaveTextContent("12 calls");
    expect(card).not.toHaveTextContent("No tool errors");
  });

  it("groups a yes/no question row under its evaluator", () => {
    renderWithProviders(
      <EvaluatorScorecardSummary
        rows={[
          {
            key: "judge:rubricChecks:q:answer-grounded-in-results-grounded",
            label: "Every claim is backed by a tool result",
            role: "advisory",
            rubricCheck: { key: "q:answer-grounded-in-results-grounded" },
            result: {
              state: "passed",
              source: "scoreRow",
              reason: "Yes · P(yes) 0.97",
            },
          },
        ]}
      />,
    );
    const card = screen.getByRole("region", {
      name: "Answer Grounded in Results",
    });
    expect(card).toHaveTextContent("Passed");
  });

  it("groups a library judge row under its evaluator", () => {
    renderWithProviders(
      <EvaluatorScorecardSummary
        rows={[
          {
            key: "judge:custom:answers-the-question-answers",
            label: "Answers what the user asked",
            role: "advisory",
            customJudge: { id: "answers-the-question-answers" },
            result: { state: "failed", source: "scoreRow", reason: "Off topic." },
          },
        ]}
      />,
    );
    const card = screen.getByRole("region", { name: "Answers the Question" });
    expect(card).toHaveTextContent("Failed");
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
