import { MAX_JUDGE_INSTRUCTIONS_LENGTH } from "@mcpjam/sdk/contract";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { EvaluatorPreviewPanel } from "../evaluator-preview-panel";
import { ExpectationField } from "../expectation-field";
import { ModelQuestionCard, type ModelQuestion } from "../model-question-card";
import { PromptEditor, usedVariables } from "../prompt-editor";

const question: ModelQuestion = {
  label: "Did the agent ask before buying?",
  kind: "yesno",
  passOn: "yes",
  options: [
    { label: "Asked", passes: true },
    { label: "Did not ask", passes: false },
  ],
  threshold: 0.7,
  runWhen: "always",
  role: "advisory",
};

describe("ModelQuestionCard", () => {
  it("puts the pass mark on the yes/no answer", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ModelQuestionCard value={question} onChange={onChange} />,
    );
    expect(
      screen.getByRole("region", { name: "Did the agent ask before buying?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Passes on No" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...question, passOn: "no" });
  });

  it("marks passing options on a choice question", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ModelQuestionCard
        value={{ ...question, kind: "choice" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Did not ask passes" }),
    );
    expect(onChange.mock.calls[0][0].options[1].passes).toBe(true);
  });

  it("names the score slider", () => {
    renderWithProviders(
      <ModelQuestionCard
        value={{ ...question, kind: "score" }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("slider", { name: "Passing score" }),
    ).toBeInTheDocument();
  });

  it("shows the model call count for a per-match question", () => {
    renderWithProviders(
      <ModelQuestionCard
        value={{ ...question, runWhen: "per-match" }}
        onChange={() => {}}
        estimatedCalls={12}
      />,
    );
    expect(
      screen.getByText("About 12 model calls per run"),
    ).toBeInTheDocument();
  });
});

describe("PromptEditor", () => {
  const variables = [
    { name: "user_request", path: "trace.messages" },
    { name: "tool_results", path: "transcript.toolResults" },
  ];

  it("lists the variables a prompt uses once each", () => {
    expect(usedVariables("{{a}} and {{ b }} then {{a}}")).toEqual(["a", "b"]);
  });

  it("flags unknown variables before save", () => {
    renderWithProviders(
      <PromptEditor
        value="Check {{user_request}} against {{cart}}"
        onChange={() => {}}
        variables={variables}
        scope="iteration"
      />,
    );
    expect(screen.getByLabelText("Judge prompt")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByText(
        "Unknown variable: cart. Type {{ to pick one from the list.",
      ),
    ).toBeInTheDocument();
  });

  it("opens the variable list on {{ and inserts the pick", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <PromptEditor
        value=""
        onChange={onChange}
        variables={variables}
        scope="iteration"
      />,
    );
    const box = screen.getByLabelText("Judge prompt");
    fireEvent.change(box, { target: { value: "Use {{" } });
    rerender(
      <PromptEditor
        value="Use {{"
        onChange={onChange}
        variables={variables}
        scope="iteration"
      />,
    );
    fireEvent.click(screen.getByRole("option", { name: /tool_results/ }));
    expect(onChange).toHaveBeenLastCalledWith("Use {{tool_results}}");
  });

  it("flags a token the judge would reject, such as a hyphenated name", () => {
    renderWithProviders(
      <PromptEditor
        value="{{tool_results}} and {{tool-results}}"
        onChange={() => {}}
        variables={variables}
        scope="iteration"
      />,
    );
    expect(screen.getByLabelText("Judge prompt")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("refuses a pick that would pass the length limit and keeps the text", () => {
    const onChange = vi.fn();
    const full = `${"x".repeat(MAX_JUDGE_INSTRUCTIONS_LENGTH - 2)}{{`;
    const { rerender } = renderWithProviders(
      <PromptEditor
        value=""
        onChange={onChange}
        variables={variables}
        scope="iteration"
      />,
    );
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: full },
    });
    rerender(
      <PromptEditor
        value={full}
        onChange={onChange}
        variables={variables}
        scope="iteration"
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByRole("option", { name: /tool_results/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "No room for {{tool_results}}. Shorten the prompt to add it.",
      ),
    ).toBeInTheDocument();
  });

  it("puts the caret right after a token inserted mid-sentence", () => {
    function Controlled() {
      const [value, setValue] = useState("Check  please");
      return (
        <PromptEditor
          value={value}
          onChange={setValue}
          variables={variables}
          scope="iteration"
        />
      );
    }
    renderWithProviders(<Controlled />);
    const box = screen.getByLabelText<HTMLTextAreaElement>("Judge prompt");
    // Type {{ mid-sentence: set the value and caret the way typing would,
    // then fire the input event React listens to.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setValue?.call(box, "Check {{ please");
    box.setSelectionRange(8, 8);
    fireEvent.input(box);
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.click(screen.getByRole("option", { name: /tool_results/ }));
    expect(box.value).toBe("Check {{tool_results}} please");
    expect(box.selectionStart).toBe("Check {{tool_results}}".length);
  });
});

describe("EvaluatorPreviewPanel", () => {
  it("says nothing is saved, shows cost and offers Correct", () => {
    const onRun = vi.fn();
    const onCorrect = vi.fn();
    renderWithProviders(
      <EvaluatorPreviewPanel
        sourceLabel="Run #4 · last 3 iterations"
        iterationCount={3}
        costLabel="About $0.02"
        results={[
          { id: "i1", iterationLabel: "Iteration #1", status: "failed" },
        ]}
        onRun={onRun}
        onCorrect={onCorrect}
      />,
    );
    expect(
      screen.getByText(/Nothing is saved · About \$0.02/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run 3" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Correct Iteration #1" }),
    );
    expect(onCorrect).toHaveBeenCalledWith("i1");
  });
});

describe("ExpectationField", () => {
  it("shows the editor and who reads it", () => {
    renderWithProviders(
      <ExpectationField
        field="postCondition"
        isNew
        readBy={[{ evaluatorId: "e1", name: "Post-condition Holds" }]}
      >
        <input aria-label="Tool" />
      </ExpectationField>,
    );
    const field = screen.getByRole("region", { name: "Post-condition" });
    expect(field).toHaveTextContent("New");
    expect(field).toHaveTextContent("Read by Post-condition Holds");
    expect(screen.getByLabelText("Tool")).toBeInTheDocument();
  });

  it("collapses when no evaluator reads the field", () => {
    renderWithProviders(
      <ExpectationField field="callBudget" readBy={[]}>
        <input aria-label="Budget" />
      </ExpectationField>,
    );
    expect(screen.queryByLabelText("Budget")).not.toBeInTheDocument();
    const hint = screen.getByText(
      "No evaluator on this suite reads this field.",
    );
    // One compact line: the hint sits in the title's row.
    expect(hint.parentElement).toBe(screen.getByRole("heading").parentElement);
  });
});
