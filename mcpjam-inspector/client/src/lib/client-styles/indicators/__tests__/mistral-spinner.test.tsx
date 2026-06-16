import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MistralSpinnerIndicator } from "../mistral-spinner";

describe("MistralSpinnerIndicator", () => {
  it("renders Le Chat's spinner and centered mark", () => {
    const { container } = render(<MistralSpinnerIndicator />);

    expect(screen.getByTestId("loading-indicator-mistral")).toHaveTextContent(
      "Thinking"
    );
    expect(
      screen.getByRole("progressbar", { name: "Loading" })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-mistral-mark")
    ).toBeInTheDocument();

    const spinningGroup = container.querySelector("g");
    expect(spinningGroup).toHaveClass("animate-spin");
    expect(
      container.querySelector("[stroke-dasharray='56.548667764616276']")
    ).toBeInTheDocument();
  });
});
