import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReplayedScenarioPane } from "../replayed-scenario-pane";
import type { EvalIteration } from "../../types";

vi.mock("../../step-list-editor", () => ({
  StepListEditor: () => <div data-testid="step-list-editor" />,
}));

const iteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  createdBy: "user-1",
  createdAt: Date.now() - 11 * 60 * 60 * 1000,
  iterationNumber: 1,
  updatedAt: Date.now() - 11 * 60 * 60 * 1000,
  status: "completed",
  result: "passed",
  actualToolCalls: [],
  tokensUsed: 0,
  testCaseSnapshot: {
    steps: [{ kind: "prompt", prompt: "hello" }],
  },
};

describe("ReplayedScenarioPane", () => {
  it("renders a minimal replay header with back action", () => {
    render(
      <ReplayedScenarioPane
        iteration={iteration}
        edited={false}
        onBackToEditing={vi.fn()}
      />,
    );

    expect(screen.getByText(/Viewing run/i)).toBeInTheDocument();
    expect(screen.getByText(/Iter #1/)).toBeInTheDocument();
    expect(screen.getByText(/11h ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to editing/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /case changed since this run/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the edited-case note in a popover", async () => {
    render(
      <ReplayedScenarioPane
        iteration={iteration}
        edited
        onBackToEditing={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/frozen at run time/i),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /case changed since this run/i }),
    );

    expect(
      await screen.findByText(/frozen at run time/i),
    ).toBeInTheDocument();
  });

  it("calls onBackToEditing from the header action", () => {
    const onBackToEditing = vi.fn();
    render(
      <ReplayedScenarioPane
        iteration={iteration}
        edited={false}
        onBackToEditing={onBackToEditing}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /back to editing/i }));
    expect(onBackToEditing).toHaveBeenCalledTimes(1);
  });

  it("copies the full iteration id from the header chip", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ReplayedScenarioPane
        iteration={iteration}
        edited={false}
        onBackToEditing={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", {
      name: /copy iteration id iter-1/i,
    });
    fireEvent.click(chip);
    expect(writeText).toHaveBeenCalledWith("iter-1");
  });
});
