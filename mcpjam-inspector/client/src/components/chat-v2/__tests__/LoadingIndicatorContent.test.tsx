import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingIndicatorContent } from "../shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "../shared/claude-loading-indicator";

const mockUseReducedMotion = vi.hoisted(() => vi.fn(() => false));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: mockUseReducedMotion,
  };
});

describe("LoadingIndicatorContent", () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  it("falls back to the static Claude mascot when reduced motion is enabled", () => {
    mockUseReducedMotion.mockReturnValue(true);

    render(<LoadingIndicatorContent variant="claude-mark" />);

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-static"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByTestId("loading-indicator-claude-strip-900"),
    ).toHaveAttribute("hidden");
    expect(
      screen.getByTestId("loading-indicator-claude-strip-800"),
    ).toHaveAttribute("hidden");
  });

  it("renders the direct static Claude mode without animated strips", () => {
    render(<ClaudeLoadingIndicator mode="static" />);

    expect(screen.getByTestId("loading-indicator-claude")).toHaveAttribute(
      "data-claude-mode",
      "static",
    );
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-static"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByTestId("loading-indicator-claude-strip-900"),
    ).toHaveAttribute("hidden");
    expect(
      screen.getByTestId("loading-indicator-claude-strip-800"),
    ).toHaveAttribute("hidden");
  });
});
