import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalsHeader } from "../evals-header";

describe("EvalsHeader", () => {
  it("renders the Evaluate landing chrome and wires Create suite", () => {
    const onCreateSuite = vi.fn();
    render(<EvalsHeader onCreateSuite={onCreateSuite} />);

    expect(screen.getByTestId("evals-header")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evaluate" })).toBeTruthy();
    expect(
      screen.getByText(
        "We generate cases from live discovery, or describe behaviors in chat, or import your existing tests.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^suites$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^runs$/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^create suite$/i }));
    expect(onCreateSuite).toHaveBeenCalledTimes(1);
  });

  it("renders Suites and Runs tabs on the landing and switches the active view", () => {
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

  it("renders a minimal Evaluate / title trail on detail routes", () => {
    const onEvaluateClick = vi.fn();
    render(
      <EvalsHeader onCreateSuite={vi.fn()} onEvaluateClick={onEvaluateClick}>
        checkout-flow
      </EvalsHeader>,
    );

    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(
      screen.queryByText(/We generate cases from live discovery/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^suites$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^runs$/i })).toBeNull();

    const evaluate = screen.getByRole("button", { name: /^evaluate$/i });
    expect(evaluate.className).toMatch(/text-muted-foreground/);
    expect(evaluate.className).toMatch(/font-normal/);
    expect(screen.getByText("/")).toBeTruthy();
    const current = screen.getByRole("link", {
      name: "checkout-flow",
      current: "page",
    });
    expect(current.className).toMatch(/font-semibold/);
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();

    fireEvent.click(evaluate);
    expect(onEvaluateClick).toHaveBeenCalledTimes(1);
  });

  it("hides Create suite when no handler is provided", () => {
    render(<EvalsHeader />);

    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
  });

  it("hides Create suite on detail routes even before the last crumb loads", () => {
    render(
      <EvalsHeader onCreateSuite={vi.fn()} isDetail>
        {null}
      </EvalsHeader>,
    );

    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
  });

  it("renders a clickable suite crumb so nested pages can go back", () => {
    const onSuiteClick = vi.fn();
    render(
      <EvalsHeader
        onEvaluateClick={vi.fn()}
        parentCrumb={{ label: "checkout-flow", onClick: onSuiteClick }}
      >
        Pay invoice
      </EvalsHeader>,
    );

    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "checkout-flow" }));
    expect(onSuiteClick).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: "Pay invoice", current: "page" }),
    ).toBeTruthy();
  });
});
