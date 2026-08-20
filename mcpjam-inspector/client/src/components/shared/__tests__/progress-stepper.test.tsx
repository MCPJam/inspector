import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProgressStepper,
  progressStepperState,
} from "../progress-stepper";

const STEPS = [
  { id: "describe", label: "Describe" },
  { id: "confirm", label: "Confirm personas" },
  { id: "running", label: "Running" },
  { id: "findings", label: "Findings" },
] as const;

describe("progressStepperState", () => {
  it("splits the rail at the active index", () => {
    expect(progressStepperState(0, 1)).toBe("complete");
    expect(progressStepperState(1, 1)).toBe("current");
    expect(progressStepperState(2, 1)).toBe("upcoming");
  });
});

describe("ProgressStepper", () => {
  it("marks exactly one step current, for assistive tech too", () => {
    render(<ProgressStepper steps={STEPS} activeIndex={1} />);

    const current = screen.getAllByRole("listitem").filter(
      (item) => item.getAttribute("aria-current") === "step"
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Confirm personas");
  });

  it("renders every step as inert text when no handler is given", () => {
    // A read-only progress indicator, not navigation that silently does
    // nothing — including the completed steps.
    render(<ProgressStepper steps={STEPS} activeIndex={2} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    for (const step of STEPS) {
      expect(screen.getByText(step.label)).toBeInTheDocument();
    }
  });

  it("offers only completed steps as a way back by default", () => {
    const onStepSelect = vi.fn();
    render(
      <ProgressStepper
        steps={STEPS}
        activeIndex={2}
        onStepSelect={onStepSelect}
      />
    );

    expect(
      screen.getAllByRole("button").map((node) => node.getAttribute("aria-label"))
    ).toEqual(["Back to Describe", "Back to Confirm personas"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to Describe" }));
    expect(onStepSelect).toHaveBeenCalledWith(0);
  });

  it("lets the caller veto a completed step", () => {
    // "Already visited" is not "safe to revisit": Swarm can't rewind past a
    // launch without re-running it, so the predicate is the caller's call.
    render(
      <ProgressStepper
        steps={STEPS}
        activeIndex={3}
        onStepSelect={vi.fn()}
        isStepSelectable={() => false}
      />
    );

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("numbers upcoming steps and checks off completed ones", () => {
    render(<ProgressStepper steps={STEPS} activeIndex={1} />);

    // Step 1 is done, so its numeral is replaced by a check; the current and
    // upcoming steps keep their numbers.
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("draws one connector fewer than it has steps", () => {
    const { container } = render(
      <ProgressStepper steps={STEPS} activeIndex={0} testId="stepper" />
    );

    const connectors = container.querySelectorAll('[aria-hidden="true"].grow');
    expect(connectors).toHaveLength(STEPS.length - 1);
    expect(screen.getByTestId("stepper")).toBeInTheDocument();
  });
});
