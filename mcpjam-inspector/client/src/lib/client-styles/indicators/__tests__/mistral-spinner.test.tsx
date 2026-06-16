import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MistralSpinnerIndicator } from "../mistral-spinner";

describe("MistralSpinnerIndicator", () => {
  it("renders Le Chat's spinner and centered mark", () => {
    const { container } = render(<MistralSpinnerIndicator />);

    expect(screen.getByTestId("loading-indicator-mistral")).toHaveTextContent(
      "Thinking"
    );
    expect(screen.getByTestId("loading-indicator-mistral")).toHaveClass(
      "mistral-spinner-indicator"
    );
    expect(
      screen.getByRole("progressbar", { name: "Loading" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("loading-indicator-mistral-spinner")).toHaveClass(
      "absolute",
      "inset-0",
      "size-12"
    );
    expect(
      screen.getByTestId("loading-indicator-mistral-mark")
    ).toBeInTheDocument();
    const mark = screen.getByTestId("loading-indicator-mistral-mark");
    expect(mark.tagName).toBe("DIV");
    expect(mark).toHaveClass("relative", "size-12");
    expect(mark).toHaveStyle({ borderRadius: "50%" });
    expect(mark.querySelector('[data-slot="avatar"]')).toHaveClass(
      "h-7",
      "w-7",
      "overflow-hidden",
      "rounded-full"
    );
    expect(mark.querySelector(".bg-brand-500")).toBeInTheDocument();
    expect(mark.querySelector(".bg-brand-500")).toHaveStyle({
      backgroundColor: "var(--bg-brand-500, var(--mistral-spinner-brand))",
    });
    expect(
      screen.getByTestId("loading-indicator-mistral-mark").querySelector("svg")
    ).toHaveClass("text-white-default");
    expect(
      screen.getByTestId("loading-indicator-mistral-mark").querySelector("svg")
    ).toHaveStyle({
      color: "var(--text-white-default, var(--mistral-spinner-white))",
    });
    expect(mark.lastElementChild).toBe(
      screen.getByTestId("loading-indicator-mistral-spinner")
    );

    const spinningGroup = container.querySelector("g");
    expect(spinningGroup).toHaveClass("animate-spin");
    expect(
      container.querySelector("[stroke-dasharray='56.548667764616276']")
    ).toBeInTheDocument();
  });
});
