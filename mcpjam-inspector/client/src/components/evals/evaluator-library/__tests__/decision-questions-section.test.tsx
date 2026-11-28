import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  DecisionEditor,
  DecisionQuestionsSection,
} from "../decision-questions-section";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));

const first = {
  id: "citation",
  kind: "yesno",
  label: "Citations",
  instructions: "Does it cite a source?",
  pass: { answer: "yes" },
} satisfies RubricCheckQuestion;
const second = { ...first, id: "links", label: "Links" };

const judges: SuiteCapabilities["judges"] = {
  rubricChecks: {
    role: "advisory",
    template: { version: 2, hash: "rubric" },
    questionKinds: ["yesno", "choice", "score"],
    execution: "wired",
    calibration: "unavailable",
  },
};

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function questionText() {
  return screen.getByRole("textbox", { name: "Question 1 text" });
}

function section(
  questions: RubricCheckQuestion[],
  onChange: ReturnType<typeof vi.fn>,
) {
  return (
    <DecisionQuestionsSection
      capabilities={{ judges }}
      judgeConfig={{ rubricChecks: { questions } }}
      onChange={onChange}
    />
  );
}

describe("decision question drafts", () => {
  it("keeps the active draft when a different question is removed", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      section([first, second], onChange),
    );
    click("Edit Citations");
    fireEvent.change(questionText(), {
      target: { value: "Does it cite two sources?" },
    });
    click("Remove Links");
    expect(onChange).toHaveBeenLastCalledWith({
      rubricChecks: { questions: [first] },
    });
    rerender(section([first], onChange));
    expect(questionText()).toHaveValue("Does it cite two sources?");
    click("Save question");
    expect(onChange).toHaveBeenLastCalledWith({
      rubricChecks: {
        questions: [{ ...first, instructions: "Does it cite two sources?" }],
      },
    });
  });

  it("blocks a stale save after the edited question changes", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(section([first], onChange));
    click("Edit Citations");
    click("No");
    const updated = { ...first, instructions: "Does it cite a tool result?" };
    rerender(section([updated], onChange));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This question changed",
    );
    expect(screen.getByRole("button", { name: "No" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save question" }),
    ).toBeDisabled();
    click("Save question");
    expect(onChange).not.toHaveBeenCalled();
    click("Cancel");
    click("Edit Citations");
    expect(questionText()).toHaveValue(updated.instructions);
    click("No");
    click("Save question");
    expect(onChange).toHaveBeenCalledWith({
      rubricChecks: { questions: [{ ...updated, pass: { answer: "no" } }] },
    });
  });

  it("avoids a reserved catalog ID when naming a question and rejects it when entered", () => {
    const onSave = vi.fn();
    renderWithProviders(
      <DecisionEditor
        canAskYesNo
        questions={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Question 1 label" }),
      {
        target: { value: "Reports Tool Errors Reports Failures" },
      },
    );
    fireEvent.change(questionText(), {
      target: { value: "Does it cite a source?" },
    });
    const id = screen.getByRole("textbox", { name: "Question 1 id" });
    const reservedId = "reports-tool-errors-reports-failures";
    expect(id).toHaveValue(`${reservedId}-2`);
    fireEvent.change(id, { target: { value: reservedId } });
    click("Add question");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a different ID.",
    );
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(id, { target: { value: "different-question" } });
    click("Add question");
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "different-question" }),
    );
  });
});

const tone = {
  id: "tone",
  kind: "choice",
  label: "Tone",
  instructions: "Which fits the reply?",
  options: [
    { id: "warm", label: "Warm" },
    { id: "curt", label: "Curt" },
  ],
  pass: { anyOf: [] },
} satisfies RubricCheckQuestion;

describe("editing a decision question", () => {
  it("shows why an authored question cannot be saved yet", () => {
    const onChange = vi.fn();
    renderWithProviders(section([tone], onChange));
    click("Edit Tone");
    click("Save question");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /at least one option as passing/,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks an option as passing through the pass line", () => {
    const onChange = vi.fn();
    renderWithProviders(section([tone], onChange));
    click("Edit Tone");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Question 1 option 1 passes" }),
    );
    click("Save question");
    expect(onChange).toHaveBeenCalledWith({
      rubricChecks: { questions: [{ ...tone, pass: { anyOf: ["warm"] } }] },
    });
  });

  it("says an unsure answer counts as No when the question passes on No", () => {
    renderWithProviders(
      section([{ ...first, pass: { answer: "no" } }], vi.fn()),
    );
    click("Edit Citations");
    expect(
      screen.getByTestId("rubric-question-1-unsure-note"),
    ).toHaveTextContent(
      "An unsure answer counts as No, so this question passes when the grader can't tell.",
    );
    click("Yes");
    expect(
      screen.queryByTestId("rubric-question-1-unsure-note"),
    ).not.toBeInTheDocument();
  });

  it("shows a kind from a newer backend by name, with no pass-line editor or error", () => {
    // As the wire delivers it: this build's types do not know the kind.
    const ranking: RubricCheckQuestion = JSON.parse(
      JSON.stringify({ ...first, kind: "ranking", pass: {} }),
    );
    renderWithProviders(section([ranking], vi.fn()));
    click("Edit Citations");
    expect(screen.getByText("ranking")).toBeInTheDocument();
    expect(screen.queryByText("Levels, lowest first.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
