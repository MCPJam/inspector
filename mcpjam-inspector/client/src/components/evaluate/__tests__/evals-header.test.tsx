import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalsHeader } from "../evals-header";

describe("EvalsHeader", () => {
  it("renders the Evaluate landing chrome and wires Create suite", () => {
    const onCreateSuite = vi.fn();
    render(<EvalsHeader onCreateSuite={onCreateSuite} />);

    const header = screen.getByTestId("evals-header");
    expect(header).toBeTruthy();
    // Same chrome as Swarm / User Testing: page surface, faint header rule.
    expect(header.className).not.toMatch(/bg-muted/);
    expect(header.className).toMatch(/border-b/);
    expect(screen.getByRole("heading", { name: "Evaluate" })).toBeTruthy();
    expect(
      screen.getByText(
        "The manual pass you'd do before a ship, automated and run whenever the server changes.",
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

    const row = screen.getByTestId("evals-header-title-row");
    const suites = screen.getByRole("button", { name: /^suites$/i });
    const runs = screen.getByRole("button", { name: /^runs$/i });
    expect(row).toContainElement(screen.getByRole("heading", { name: "Evaluate" }));
    expect(row).toContainElement(screen.getByTestId("evals-header-title-rule"));
    expect(row).toContainElement(suites);
    expect(row).toContainElement(runs);
    expect(
      screen.getByRole("navigation", { name: "Evaluate view" }).className,
    ).toMatch(/min-h-8/);
    expect(suites).toHaveAttribute("aria-current", "page");
    expect(runs).not.toHaveAttribute("aria-current");
    expect(
      screen.getByText(
        "The manual pass you'd do before a ship, automated and run whenever the server changes.",
      ),
    ).toBeTruthy();

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
      screen.queryByText(/manual pass you'd do before a ship/i),
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
    // Both crumbs after "Evaluate" are conditional, so the separator has to be
    // too — otherwise the trail reads "Evaluate /" until the title resolves.
    expect(screen.queryByText("/")).toBeNull();
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
