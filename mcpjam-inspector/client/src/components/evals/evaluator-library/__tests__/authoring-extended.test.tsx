import { MAX_JUDGE_INSTRUCTIONS_LENGTH } from "@mcpjam/sdk/contract";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { PromptEditor, usedVariables } from "../prompt-editor";

describe("PromptEditor", () => {
  const variables = [
    { name: "user_request", description: "The user's request" },
    { name: "tool_results", description: "Each tool step with its result" },
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
        maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
      />,
    );
    const box = screen.getByLabelText("Judge prompt");
    fireEvent.change(box, { target: { value: "Use {{" } });
    rerender(
      <PromptEditor
        value="Use {{"
        onChange={onChange}
        variables={variables}
        maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
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
        maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
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
        maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
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

  it("lets the picker use a longer maxLength, such as a custom judge's", () => {
    const onChange = vi.fn();
    const long = `${"x".repeat(2_300)}{{`;
    const { rerender } = renderWithProviders(
      <PromptEditor
        value=""
        onChange={onChange}
        variables={variables}
        maxLength={4_000}
      />,
    );
    fireEvent.change(screen.getByLabelText("Judge prompt"), {
      target: { value: long },
    });
    rerender(
      <PromptEditor
        value={long}
        onChange={onChange}
        variables={variables}
        maxLength={4_000}
      />,
    );
    fireEvent.click(screen.getByRole("option", { name: /tool_results/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      `${"x".repeat(2_300)}{{tool_results}}`,
    );
    expect(screen.queryByText(/No room for/)).not.toBeInTheDocument();
    expect(screen.getByText("2302/4000")).toBeInTheDocument();
  });

  it("puts the caret right after a token inserted mid-sentence", () => {
    function Controlled() {
      const [value, setValue] = useState("Check  please");
      return (
        <PromptEditor
          value={value}
          onChange={setValue}
          variables={variables}
        maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
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
