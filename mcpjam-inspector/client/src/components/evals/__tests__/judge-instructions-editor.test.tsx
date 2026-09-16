import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JudgeInstructionsEditor } from "../judge-instructions-editor";

describe("grading instructions", () => {
  it("shows API criteria read-only and clears them without losing instructions", async () => {
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
    expect(screen.queryByLabelText("Criterion 1 label")).toBeNull();
    expect(screen.getByText("Cite the source")).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Clear criteria" }));
    expect(onChange).toHaveBeenLastCalledWith({
      instructions: "Check evidence",
    });
  });
  it("clears instructions while preserving API criteria", async () => {
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
});
