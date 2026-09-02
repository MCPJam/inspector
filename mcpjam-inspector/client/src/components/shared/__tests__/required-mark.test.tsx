import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequiredLegend, RequiredMark } from "../required-mark";

describe("RequiredMark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the glyph from assistive tech and names the field required", () => {
    render(
      <label>
        Swarm name
        <RequiredMark />
      </label>,
    );

    const glyph = screen.getByTestId("required-mark");
    expect(glyph).toHaveTextContent("*");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("(required)")).toHaveClass("sr-only");
  });

  it("explains itself on hover", () => {
    render(
      <label>
        Swarm name
        <RequiredMark />
      </label>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const glyph = screen.getByTestId("required-mark");
    act(() => {
      fireEvent.pointerMove(glyph, { pointerType: "mouse" });
      vi.runAllTimers();
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Required");
  });
});

describe("RequiredLegend", () => {
  it("spells out what the mark means", () => {
    render(<RequiredLegend />);

    expect(screen.getByTestId("required-legend")).toHaveTextContent(
      "* Required field",
    );
  });
});
