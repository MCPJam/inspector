import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalsHeader } from "../evals-header";

describe("EvalsHeader", () => {
  it("renders Suites and Runs tabs with optional landing intro", () => {
    const onCreateSuite = vi.fn();
    render(
      <EvalsHeader
        onCreateSuite={onCreateSuite}
        landingView="suites"
        onLandingViewChange={vi.fn()}
        showLandingIntro
      />,
    );

    expect(screen.getByTestId("evals-header")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evaluate" })).toBeTruthy();
    expect(
      screen.getByText(
        "We generate cases from live discovery, or describe behaviors in chat, or import your existing tests.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^suites$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^runs$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^new suite$/i }));
    expect(onCreateSuite).toHaveBeenCalledTimes(1);
  });

  it("switches landing views from the tab strip", () => {
    const onLandingViewChange = vi.fn();
    render(
      <EvalsHeader
        onCreateSuite={vi.fn()}
        landingView="suites"
        onLandingViewChange={onLandingViewChange}
      />,
    );

    const suites = screen.getByRole("button", { name: /^suites$/i });
    const runs = screen.getByRole("button", { name: /^runs$/i });
    expect(suites).toHaveAttribute("aria-current", "page");
    expect(runs).not.toHaveAttribute("aria-current");

    fireEvent.click(runs);
    expect(onLandingViewChange).toHaveBeenCalledWith("runs");
  });

  it("renders center navigation children on detail routes", () => {
    render(
      <EvalsHeader onCreateSuite={vi.fn()} landingView="suites" onLandingViewChange={vi.fn()}>
        checkout-flow
      </EvalsHeader>,
    );

    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(screen.getByText("checkout-flow")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^new suite$/i })).toBeTruthy();
  });

  it("hides New suite when no handler is provided", () => {
    render(
      <EvalsHeader landingView="suites" onLandingViewChange={vi.fn()} />,
    );

    expect(
      screen.queryByRole("button", { name: /^new suite$/i }),
    ).toBeNull();
  });
});
