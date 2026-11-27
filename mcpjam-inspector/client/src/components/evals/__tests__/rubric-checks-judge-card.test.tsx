import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import { RUBRIC_CHECKS_GOAL_OFF_COPY } from "../evaluator-library/library-pause";
import { RubricChecksJudgeCard } from "../rubric-checks-judge-card";
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

// The backend advertises yes/no by kind; its template version stays 1.
const withYesNo = {
  rubricChecks: {
    ...judgesCapabilities.rubricChecks,
    questionKinds: ["choice", "score", "yesno"],
  },
} as NonNullable<SuiteCapabilities["judges"]>;

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

  it("offers Yes/no questions only where the deployment lists the kind", () => {
    const { rerender } = render(
      <RubricChecksJudgeCard
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        judgesCapabilities={judgesCapabilities}
        criteria={criteria}
        goalJudgeOff={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Yes/no" }),
    ).not.toBeInTheDocument();
    const onChange = vi.fn();
    rerender(
      <RubricChecksJudgeCard
        judgeConfig={undefined}
        onJudgeConfigChange={onChange}
        judgesCapabilities={withYesNo}
        criteria={criteria}
        goalJudgeOff={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes/no" }));
    expect(onChange.mock.calls[0][0].rubricChecks.questions[0].kind).toBe(
      "yesno",
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

describe("RubricChecksJudgeCard yes/no and limits", () => {
  const yesNo = (id: string, answer: "yes" | "no"): RubricCheckQuestion => ({
    id,
    kind: "yesno",
    label: `Label ${id}`,
    instructions: "Did the answer present a result no tool returned?",
    pass: { answer },
  });

  function renderCard(questions: RubricCheckQuestion[]) {
    return render(
      <RubricChecksJudgeCard
        judgeConfig={{ rubricChecks: { questions } }}
        onJudgeConfigChange={vi.fn()}
        judgesCapabilities={withYesNo}
        criteria={[]}
        goalJudgeOff={false}
      />,
    );
  }

  it("says an unsure answer counts as No when the question passes on No", () => {
    renderCard([yesNo("invented", "no"), yesNo("warned", "yes")]);
    expect(
      screen.getByTestId("rubric-question-1-unsure-note"),
    ).toHaveTextContent(
      "An unsure answer counts as No, so this question passes when the grader can't tell.",
    );
    expect(
      screen.queryByTestId("rubric-question-2-unsure-note"),
    ).not.toBeInTheDocument();
  });

  it("counts library questions toward the limit and says why Add is off", () => {
    const library = {
      ...yesNo("reports-tool-errors-reports-failures", "yes"),
      evaluator: { id: "reports-tool-errors", version: 1 },
    };
    const own = Array.from({ length: 9 }, (_, i) => yesNo(`mine-${i}`, "yes"));
    renderCard([library, ...own]);
    expect(
      screen.getByText(/including 1 from library evaluators/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("rubric-checks-at-cap")).toHaveTextContent(
      "All 10 questions are in use, 1 by library evaluators. Remove a question here or an evaluator above to add another.",
    );
    for (const name of ["Yes/no", "Choice", "Score"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    // The library question is edited under its evaluator, not here.
    expect(
      screen.queryByDisplayValue("Label reports-tool-errors-reports-failures"),
    ).toBeNull();
  });

  it("shows a kind from a newer backend by name, with no pass-line editor or error", () => {
    // As the wire delivers it: this build's types do not know the kind.
    const ranking: RubricCheckQuestion = JSON.parse(
      JSON.stringify({ ...yesNo("rank", "yes"), kind: "ranking", pass: {} }),
    );
    renderCard([ranking]);
    expect(screen.getByText("ranking")).toBeInTheDocument();
    expect(screen.queryByText("Levels, lowest first.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
