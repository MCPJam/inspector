import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuiteCaseGenerationWorkspace } from "../suite-case-generation-workspace";

describe("shared generation workspace", () => {
  it("retains suite-generation chat behavior for existing callers", async () => {
    const generate = vi.fn(async () => {});
    const close = vi.fn();
    render(
      <SuiteCaseGenerationWorkspace
        suiteName="Search"
        cases={[]}
        isGenerating={false}
        onGenerate={generate}
        onCaseClick={vi.fn()}
        onClose={close}
      />,
    );
    fireEvent.change(screen.getByLabelText("Describe test case refinements"), {
      target: { value: "Add empty results" },
    });
    fireEvent.click(screen.getByLabelText("Send refinement"));
    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith("Add empty results"),
    );
    await screen.findByText(/The refinement pass is complete/);
    fireEvent.click(screen.getByText("Done"));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("does not submit while preparation is pending", () => {
    const generate = vi.fn();
    render(
      <SuiteCaseGenerationWorkspace
        suiteName="Search"
        caseRows={[]}
        isGenerating
        onGenerate={generate}
        onCaseClick={vi.fn()}
        onClose={vi.fn()}
        doneLabel="Continue"
        refinementDisabledReason="Waiting for saved tools"
      />,
    );
    expect(
      screen.getByLabelText("Describe test case refinements"),
    ).toBeDisabled();
    expect(screen.getByLabelText("Send refinement")).toBeDisabled();
    expect(screen.getByText("Continue")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Send refinement"));
    expect(generate).not.toHaveBeenCalled();
  });
});
