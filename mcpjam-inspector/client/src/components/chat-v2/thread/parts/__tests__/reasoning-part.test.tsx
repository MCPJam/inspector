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

  it("hides redacted reasoning", () => {
    const { container } = render(<ReasoningPart text="[REDACTED]" />);

    expect(container.firstChild).toBeNull();
  });
});
