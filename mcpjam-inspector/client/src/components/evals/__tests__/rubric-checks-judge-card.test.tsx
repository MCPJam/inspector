import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  RUBRIC_CHECKS_GOAL_OFF_COPY,
  RubricChecksJudgeCard,
} from "../rubric-checks-judge-card";
import { SuiteJudgeCard } from "../suite-judge-card";
import { RUBRIC_CHECK_QUESTION_IDENTITY_HINT } from "../rubric-checks-model";

const judgesCapabilities = {
  rubricChecks: {
    role: "advisory",
    template: { version: 1, hash: "h" },
    execution: "wired",
    calibration: "unavailable",
  },
} as unknown as NonNullable<SuiteCapabilities["judges"]>;

const criteria = [
  { id: "cites", label: "Cites a source" },
  { id: "polite", label: "Stays polite" },
];

describe("RubricChecksJudgeCard", () => {
  it("lists each criterion as the yes or no it will be asked", () => {
    render(
      <SuiteJudgeCard
        slot="rubricChecks"
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
      />,
    );
    const card = screen.getByTestId("suite-judge-card-rubricChecks");
    expect(card.getAttribute("data-setting-key")).toBe("judgeRubricChecks");
    expect(
      screen.getByTestId("suite-judge-template-rubricChecks").textContent,
    ).toBe("Template v1");
    const derived = screen.getByTestId("rubric-checks-derived");
    expect(derived.textContent).toContain("Cites a source");
    expect(derived.textContent).toContain("Stays polite");
    // Wording edits churn the row identity, and the card says so.
    expect(screen.getByTestId("rubric-checks-identity-hint").textContent).toBe(
      RUBRIC_CHECK_QUESTION_IDENTITY_HINT,
    );
  });

  it("says where criteria come from when there are none", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        judgesCapabilities={judgesCapabilities}
        criteria={[]}
        goalJudgeOff={false}
      />,
    );
    expect(screen.getByTestId("rubric-checks-no-criteria")).toBeTruthy();
    expect(screen.queryByTestId("rubric-checks-identity-hint")).toBeNull();
  });

  it("says the checks are paused while the goal judge is off", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={{ goalCompletion: { enabled: false } }}
        onJudgeConfigChange={vi.fn()}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
        goalJudgeOff
      />,
    );
    expect(screen.getByTestId("rubric-checks-goal-off").textContent).toBe(
      RUBRIC_CHECKS_GOAL_OFF_COPY,
    );
  });

  it("adds a question into the slot and keeps the goal judge's config", () => {
    const onChange = vi.fn();
    render(
      <RubricChecksJudgeCard
        judgeConfig={{ goalCompletion: { threshold: 0.8 } }}
        onJudgeConfigChange={onChange}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
        goalJudgeOff={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Score/ }));
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: { threshold: 0.8 },
      rubricChecks: {
        questions: [
          {
            id: "score",
            kind: "score",
            label: "",
            instructions: "",
            levels: ["", "", ""],
            pass: { minLevel: 2 },
          },
        ],
      },
    });
  });

  it("shows why an authored question cannot be saved yet", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={{
          rubricChecks: {
            questions: [
              {
                id: "tone",
                kind: "choice",
                label: "Tone",
                instructions: "Which fits the reply?",
                options: [
                  { id: "warm", label: "Warm" },
                  { id: "curt", label: "Curt" },
                ],
                pass: { anyOf: [] },
              },
            ],
          },
        }}
        onJudgeConfigChange={vi.fn()}
        judgesCapabilities={judgesCapabilities}
        criteria={[]}
        goalJudgeOff={false}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /at least one option as passing/,
    );
  });

  it("marks an option as passing through the pass line", () => {
    const onChange = vi.fn();
    render(
      <RubricChecksJudgeCard
        judgeConfig={{
          rubricChecks: {
            questions: [
              {
                id: "tone",
                kind: "choice",
                label: "Tone",
                instructions: "Which fits the reply?",
                options: [
                  { id: "warm", label: "Warm" },
                  { id: "curt", label: "Curt" },
                ],
                pass: { anyOf: [] },
              },
            ],
          },
        }}
        onJudgeConfigChange={onChange}
        judgesCapabilities={judgesCapabilities}
        criteria={[]}
        goalJudgeOff={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Question 1 option 1 passes" }),
    );
    expect(onChange.mock.calls[0][0].rubricChecks.questions[0].pass).toEqual({
      anyOf: ["warm"],
    });
  });
});
