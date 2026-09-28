import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JudgeInstructionsEditor } from "../judge-instructions-editor";
import { RUBRIC_CHECK_ROW_IDENTITY_HINT } from "../judge-rubric-editor";

describe("grading instructions", () => {
  it("edits criteria in place, keeping the instructions", () => {
    // Criteria used to be settable through the API alone and shown read-only
    // here, so no suite author could write one. They are edited in place now.
    const onChange = vi.fn();
    render(
      <JudgeInstructionsEditor
        value={{
          instructions: "Check evidence",
          criteria: [{ id: "cite", label: "Cite the source", required: true }],
        }}
        onChange={onChange}
      />,
    );
    const label = screen.getByLabelText("Criterion 1 label");
    expect((label as HTMLInputElement).value).toBe("Cite the source");
    fireEvent.change(label, { target: { value: "Cite every source" } });
    expect(onChange).toHaveBeenLastCalledWith({
      instructions: "Check evidence",
      criteria: [{ id: "cite", label: "Cite every source", required: true }],
    });
  });

  it("adds a criterion to a suite that had none", async () => {
    const onChange = vi.fn();
    render(
      <JudgeInstructionsEditor
        value={{ instructions: "Check" }}
        onChange={onChange}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Add criterion" }));
    expect(onChange).toHaveBeenLastCalledWith({
      instructions: "Check",
      criteria: [{ id: "criterion", label: "" }],
    });
  });

  it("removing the last criterion keeps the instructions", async () => {
    const onChange = vi.fn();
    render(
      <JudgeInstructionsEditor
        value={{
          instructions: "Check evidence",
          criteria: [{ id: "cite", label: "Cite the source" }],
        }}
        onChange={onChange}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove criterion 1" }));
    expect(onChange).toHaveBeenLastCalledWith({
      instructions: "Check evidence",
    });
  });

  it("clears instructions while preserving criteria", async () => {
    const onChange = vi.fn();
    const criteria = [{ id: "cite", label: "Cite source" }];
    render(
      <JudgeInstructionsEditor
        value={{ instructions: "Check", criteria }}
        onChange={onChange}
      />,
    );
    await userEvent
      .setup()
      .clear(screen.getByLabelText(/Grading instructions/));
    expect(onChange).toHaveBeenLastCalledWith({ criteria });
  });

  it("says that a wording edit starts a new rubric-check row, only when asked to", () => {
    const value = { criteria: [{ id: "cite", label: "Cite source" }] };
    const { rerender } = render(
      <JudgeInstructionsEditor value={value} onChange={vi.fn()} />,
    );
    expect(screen.queryByText(RUBRIC_CHECK_ROW_IDENTITY_HINT)).toBeNull();
    rerender(
      <JudgeInstructionsEditor
        value={value}
        onChange={vi.fn()}
        rowIdentityHint={RUBRIC_CHECK_ROW_IDENTITY_HINT}
      />,
    );
    expect(screen.getByText(RUBRIC_CHECK_ROW_IDENTITY_HINT)).toBeTruthy();
  });
});
