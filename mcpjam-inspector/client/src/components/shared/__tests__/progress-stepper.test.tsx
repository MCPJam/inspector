import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  clampStepIndex,
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

  it("keeps every step a real list item, and the connectors out of the list", () => {
    // The steps used to be `display: contents`, which drops the <li> from the
    // layout — and, in Safari before 16.4, from the accessibility tree too,
    // taking `listitem` and this component's `aria-current` contract with it.
    // The connectors are decoration, so they are hidden instead of counted.
    render(<ProgressStepper steps={STEPS} activeIndex={1} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(STEPS.length);
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Describe"),
      expect.stringContaining("Confirm personas"),
      expect.stringContaining("Running"),
      expect.stringContaining("Findings"),
    ]);
    for (const item of items) {
      expect(item.className).not.toContain("contents");
    }
  });
});

describe("clampStepIndex", () => {
  it("snaps anything a caller can hand over onto a real step", () => {
    expect(clampStepIndex(-3, 4)).toBe(0);
    expect(clampStepIndex(9, 4)).toBe(3);
    expect(clampStepIndex(1.7, 4)).toBe(1);
    expect(clampStepIndex(Number.NaN, 4)).toBe(0);
    expect(clampStepIndex(Number.POSITIVE_INFINITY, 4)).toBe(0);
    expect(clampStepIndex(2, 4)).toBe(2);
  });

  it("survives an empty rail", () => {
    expect(clampStepIndex(0, 0)).toBe(0);
    expect(clampStepIndex(5, 0)).toBe(0);
  });
});

describe("ProgressStepper — the activeIndex contract", () => {
  // Left unclamped, an out-of-range index rendered a rail with NO current step
  // and no `aria-current` anywhere: a stepper that had quietly stopped saying
  // where you are.
  const currentLabels = () =>
    screen
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "step")
      .map((item) => item.textContent);

  it("keeps exactly one step current for an index past the end", () => {
    render(<ProgressStepper steps={STEPS} activeIndex={99} />);
    expect(currentLabels()).toEqual([expect.stringContaining("Findings")]);
  });

  it("keeps exactly one step current for a negative index", () => {
    render(<ProgressStepper steps={STEPS} activeIndex={-4} />);
    expect(currentLabels()).toEqual([expect.stringContaining("Describe")]);
  });

  it("keeps exactly one step current for a non-integer index", () => {
    render(<ProgressStepper steps={STEPS} activeIndex={2.6} />);
    expect(currentLabels()).toEqual([expect.stringContaining("Running")]);
  });

  it("renders an empty rail without throwing", () => {
    const { container } = render(<ProgressStepper steps={[]} activeIndex={0} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
