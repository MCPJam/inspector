import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReasoningPart } from "../reasoning-part";

describe("ReasoningPart", () => {
  it("renders reasoning inline by default", () => {
    render(<ReasoningPart text="Reasoned response" />);

    expect(screen.getByText("Reasoned response")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reasoning/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses reasoning in trace mode and expands on demand", () => {
    render(
      <ReasoningPart
        text="Private reasoning for trace viewers"
        displayMode="collapsed"
      />,
    );

    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Private reasoning for trace viewers"),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Private reasoning for trace viewers"),
    ).toBeInTheDocument();
  });

  it("shows collapsible reasoning expanded by default", () => {
    render(
      <ReasoningPart text="Owner thread reasoning" displayMode="collapsible" />,
    );

    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Owner thread reasoning")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Owner thread reasoning"),
    ).not.toBeInTheDocument();
  });

  it("hides reasoning when display mode is hidden", () => {
    const { container } = render(
      <ReasoningPart
        text="Not for public sandbox viewers"
        displayMode="hidden"
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("hides redacted reasoning", () => {
    const { container } = render(<ReasoningPart text="[REDACTED]" />);

    expect(container.firstChild).toBeNull();
  });
});
