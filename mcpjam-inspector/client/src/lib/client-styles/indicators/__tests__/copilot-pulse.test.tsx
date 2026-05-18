import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CopilotPulseIndicator } from "../copilot-pulse";

describe("CopilotPulseIndicator", () => {
  it("renders the pulse container with all three circles", () => {
    const { getByTestId } = render(<CopilotPulseIndicator />);
    expect(getByTestId("loading-indicator-copilot-pulse")).toBeTruthy();
    expect(getByTestId("loading-indicator-copilot-pulse-circle-1")).toBeTruthy();
    expect(getByTestId("loading-indicator-copilot-pulse-circle-2")).toBeTruthy();
    expect(getByTestId("loading-indicator-copilot-pulse-circle-3")).toBeTruthy();
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <CopilotPulseIndicator className="custom-test-class" />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("each circle binds to its per-index keyframe animation", () => {
    // Circle classes carry the animation hook via CSS (modifier classes).
    // Lock the class wiring so a refactor doesn't silently drop the
    // per-circle keyframe binding — actual animation values are asserted
    // against the live stylesheet in the preview verification.
    const { getByTestId } = render(<CopilotPulseIndicator />);
    expect(
      getByTestId("loading-indicator-copilot-pulse-circle-1").classList.contains(
        "copilot-pulse-indicator__circle--1",
      ),
    ).toBe(true);
    expect(
      getByTestId("loading-indicator-copilot-pulse-circle-2").classList.contains(
        "copilot-pulse-indicator__circle--2",
      ),
    ).toBe(true);
    expect(
      getByTestId("loading-indicator-copilot-pulse-circle-3").classList.contains(
        "copilot-pulse-indicator__circle--3",
      ),
    ).toBe(true);
  });

  it("declares an aria-live region so the thinking state is announced", () => {
    const { container } = render(<CopilotPulseIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The sr-only label gives the announcement actual content.
    expect(container.textContent).toContain("Thinking");
  });
});
