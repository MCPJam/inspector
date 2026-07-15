import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScriptedStep } from "@/shared/scripted-steps";
import { StepList } from "../scripted-steps-editor";

describe("StepList", () => {
  it("adds a default click step", () => {
    const onChange = vi.fn();
    render(<StepList value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(onChange).toHaveBeenCalledWith([
      { kind: "click", target: { testId: "" } },
    ]);
  });

  it("renders a row per existing step", () => {
    const steps: ScriptedStep[] = [
      { kind: "click", target: { role: { role: "button", name: "Save" } } },
      { kind: "assert", assertion: { type: "textVisible", text: "Saved!" } },
    ];
    render(<StepList value={steps} onChange={vi.fn()} />);
    expect(screen.getAllByTestId("scripted-step-row")).toHaveLength(2);
  });

  it("removes a step", () => {
    const onChange = vi.fn();
    const steps: ScriptedStep[] = [
      { kind: "key", key: "Enter" },
      { kind: "wait", ms: 500 },
    ];
    render(<StepList value={steps} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("button", { name: /remove step/i })[0]);
    expect(onChange).toHaveBeenCalledWith([{ kind: "wait", ms: 500 }]);
  });

  it("edits a key step's value through onChange", () => {
    const onChange = vi.fn();
    const steps: ScriptedStep[] = [{ kind: "key", key: "" }];
    render(<StepList value={steps} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/Enter, Tab, ArrowDown/i), {
      target: { value: "Enter" },
    });
    expect(onChange).toHaveBeenCalledWith([{ kind: "key", key: "Enter" }]);
  });
});
