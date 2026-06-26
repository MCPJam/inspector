import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@/test";
import { type TestStep } from "@/shared/steps";
import { StepListEditor } from "../step-list-editor";

describe("StepListEditor", () => {
  it("renders one row per derived step in order", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "Draw a cat" },
      {
        id: "2",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "create_view", args: { args: {} } },
      },
      {
        id: "3",
        kind: "interact",
        toolName: "create_view",
        action: { kind: "click", target: { testId: "canvas" } },
      },
    ];
    render(
      <StepListEditor
        steps={steps}
        onStepsChange={vi.fn()}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
      />,
    );
    const rows = screen.getAllByTestId("step-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-step-kind", "prompt");
    expect(rows[1]).toHaveAttribute("data-step-kind", "assert");
    expect(rows[2]).toHaveAttribute("data-step-kind", "interact");
  });

  it("renders per-step status (stepStatusById): assert verdict + skipped tail", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "go" },
      {
        id: "2",
        kind: "assert",
        assertion: { type: "responseContains", needle: "nope" },
      },
      { id: "3", kind: "prompt", prompt: "next" },
    ];
    render(
      <StepListEditor
        steps={steps}
        onStepsChange={vi.fn()}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
        stepStatusById={
          new Map([
            ["1", "ok"],
            ["2", "fail"],
            ["3", "skipped"],
          ])
        }
      />,
    );
    // Per-step verdicts show on EVERY card, including the assert (the
    // turn-derived path would have hidden the assert's fail).
    expect(screen.getByLabelText("Step passed")).toBeInTheDocument();
    expect(screen.getByLabelText("Step failed")).toBeInTheDocument();
    // The tail prompt was Skipped by fail-fast.
    expect(screen.getByLabelText("Step skipped")).toBeInTheDocument();
  });

  it("edits a prompt step and reports the full next sequence", () => {
    const onStepsChange = vi.fn();
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "old" },
    ];
    render(
      <StepListEditor
        steps={steps}
        onStepsChange={onStepsChange}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Enter the user prompt…"), {
      target: { value: "new" },
    });
    expect(onStepsChange).toHaveBeenCalledWith([
      { id: "1", kind: "prompt", prompt: "new" },
    ]);
  });

  it("removes a step", () => {
    const onStepsChange = vi.fn();
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "a" },
      { id: "2", kind: "prompt", prompt: "b" },
    ];
    render(
      <StepListEditor
        steps={steps}
        onStepsChange={onStepsChange}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove step 1/i }));
    expect(onStepsChange).toHaveBeenCalledWith([
      { id: "2", kind: "prompt", prompt: "b" },
    ]);
  });

  it("adds a prompt step from the unified picker", async () => {
    const user = userEvent.setup();
    const onStepsChange = vi.fn();

    render(
      <StepListEditor
        steps={[]}
        onStepsChange={onStepsChange}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
      />,
    );

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-item-prompt"));

    expect(onStepsChange).toHaveBeenCalledTimes(1);
    const next = onStepsChange.mock.calls[0][0] as TestStep[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "prompt", prompt: "" });
  });

  it("reorders a step down", () => {
    const onStepsChange = vi.fn();
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "a" },
      { id: "2", kind: "prompt", prompt: "b" },
    ];
    render(
      <StepListEditor
        steps={steps}
        onStepsChange={onStepsChange}
        availableTools={[]}
        suiteServers={[]}
        evalValidationBorderClass=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /move step 1 down/i }));
    expect(onStepsChange).toHaveBeenCalledWith([
      { id: "2", kind: "prompt", prompt: "b" },
      { id: "1", kind: "prompt", prompt: "a" },
    ]);
  });

  describe("readOnly (snapshot view)", () => {
    const steps: TestStep[] = [
      { id: "1", kind: "prompt", prompt: "Draw a cat" },
      {
        id: "2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "create_view",
          args: { args: {} },
        },
      },
    ];

    it("still renders the same step cards", () => {
      render(
        <StepListEditor
          steps={steps}
          onStepsChange={vi.fn()}
          availableTools={[]}
          suiteServers={[]}
          evalValidationBorderClass=""
          readOnly
        />,
      );
      const rows = screen.getAllByTestId("step-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAttribute("data-step-kind", "prompt");
      expect(rows[1]).toHaveAttribute("data-step-kind", "assert");
    });

    it("hides reorder/remove and add affordances", () => {
      render(
        <StepListEditor
          steps={steps}
          onStepsChange={vi.fn()}
          availableTools={[]}
          suiteServers={[]}
          evalValidationBorderClass=""
          readOnly
        />,
      );
      expect(screen.queryByRole("button", { name: /move step/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /remove step/i })).toBeNull();
      expect(
        screen.queryByRole("button", { name: /^add/i }),
      ).toBeNull();
    });

    it("locks the prompt field (read-only) so edits can't fire", () => {
      const onStepsChange = vi.fn();
      render(
        <StepListEditor
          steps={steps}
          onStepsChange={onStepsChange}
          availableTools={[]}
          suiteServers={[]}
          evalValidationBorderClass=""
          readOnly
        />,
      );
      const textarea = screen.getByPlaceholderText(
        "Enter the user prompt…",
      ) as HTMLTextAreaElement;
      expect(textarea.readOnly).toBe(true);
    });
  });
});
