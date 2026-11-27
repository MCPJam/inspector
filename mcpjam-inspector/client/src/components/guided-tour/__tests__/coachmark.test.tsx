import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TourCoachmark, TourStepContent } from "../coachmark";

const LABELS = ["Pick", "Run", "Fix"];

function renderStop(index: number) {
  const onNext = vi.fn();
  const onSkip = vi.fn();
  render(
    <TourCoachmark
      anchor={{ x: 100, y: 100, width: 200, height: 40 }}
      bounds={{ width: 1000, height: 700 }}
      placement="bottom"
    >
      <TourStepContent
        labels={LABELS}
        index={index}
        title="Pick what to check"
        body="Each category maps to a part of the MCP spec."
        onNext={onNext}
        onSkip={onSkip}
      />
    </TourCoachmark>,
  );
  return { onNext, onSkip };
}

describe("TourCoachmark", () => {
  it("is a FeatureSpotlight card labelled by the stop's title", () => {
    renderStop(0);
    const card = screen.getByRole("dialog", { name: "Pick what to check" });
    expect(card).toHaveAttribute("data-slot", "feature-spotlight-card");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Pick")).toHaveAttribute("aria-current", "step");
  });

  it("focuses Next, and both Skip tour and the X skip", () => {
    const { onNext, onSkip } = renderStop(1);
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toHaveFocus();
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledWith(next);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Close tour" }));
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("offers Finish and no Skip tour on the last stop", () => {
    renderStop(2);
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip tour" })).toBeNull();
  });
});
