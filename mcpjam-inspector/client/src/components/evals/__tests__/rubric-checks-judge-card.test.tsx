import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { RubricChecksJudgeCard } from "../rubric-checks-judge-card";
import { RUBRIC_CHECKS_GOAL_OFF_COPY } from "../evaluator-library/library-pause";
import { SuiteJudgeCard } from "../suite-judge-card";

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
  });

  it("says where criteria come from when there are none", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={undefined}
        judgesCapabilities={judgesCapabilities}
        criteria={[]}
        goalJudgeOff={false}
      />,
    );
    expect(screen.getByTestId("rubric-checks-no-criteria")).toBeTruthy();
  });

  it("says the checks are paused while the goal judge is off", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={{ goalCompletion: { enabled: false } }}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
        goalJudgeOff
      />,
    );
    expect(screen.getByTestId("rubric-checks-goal-off").textContent).toBe(
      RUBRIC_CHECKS_GOAL_OFF_COPY,
    );
  });

  it("has no question list or add buttons of its own", () => {
    render(
      <RubricChecksJudgeCard
        judgeConfig={{
          rubricChecks: {
            questions: [
              {
                id: "tone",
                kind: "yesno",
                label: "Tone",
                instructions: "Is it polite?",
                pass: { answer: "yes" },
              },
            ],
          },
        }}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
        goalJudgeOff={false}
      />,
    );
    expect(screen.queryByDisplayValue("Tone")).toBeNull();
    for (const name of ["Yes/no", "Choice", "Score"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
