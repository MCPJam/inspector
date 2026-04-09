import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingIndicatorContent } from "../shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "../shared/claude-loading-indicator";

describe("LoadingIndicatorContent", () => {
  it("renders animated Claude strips with explicit aspect ratios", () => {
    render(<ClaudeLoadingIndicator />);

    const strip900 = screen.getByTestId("loading-indicator-claude-strip-900");
    const strip800 = screen.getByTestId("loading-indicator-claude-strip-800");

    expect(strip900).not.toHaveAttribute("hidden");
    expect(strip900).toHaveAttribute("preserveAspectRatio", "xMidYMin meet");
    expect(strip900.getAttribute("style")).toContain("aspect-ratio: 1 / 9;");

    expect(strip800).not.toHaveAttribute("hidden");
    expect(strip800).toHaveAttribute("preserveAspectRatio", "xMidYMin meet");
    expect(strip800.getAttribute("style")).toContain("aspect-ratio: 1 / 8;");
  });

  it("renders the direct static Claude mode without animated strips", () => {
    const { container } = render(<ClaudeLoadingIndicator mode="static" />);

    expect(screen.getByTestId("loading-indicator-claude")).toHaveAttribute(
      "data-claude-mode",
      "static",
    );
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(container.firstChild).toHaveClass(
      "claude-loading-indicator--static",
    );
  });
});
