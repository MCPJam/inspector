import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LoadingIndicatorContent,
  resolveLoadingIndicatorVariant,
} from "../shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "../shared/claude-loading-indicator";
import { ChatboxHostStyleProvider } from "@/contexts/chatbox-host-style-context";

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

  it("defaults to the Claude mascot for Claude-style chatbox hosts", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
  });

  it("defaults to the GPT pulse for ChatGPT-style chatbox hosts", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
  });

  it('treats variant="default" as fallback so host-style mascots still render', () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <LoadingIndicatorContent variant="default" />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
  });

  it("treats undefined variant as fallback to host style", () => {
    expect(
      resolveLoadingIndicatorVariant({
        variant: undefined,
        hostStyle: "chatgpt",
      }),
    ).toBe("chatgpt-dot");
  });

  it('treats variant="default" as fallback to host style', () => {
    expect(
      resolveLoadingIndicatorVariant({
        variant: "default",
        hostStyle: "claude",
      }),
    ).toBe("claude-mark");
  });

  it("preserves explicit loading-indicator overrides", () => {
    expect(
      resolveLoadingIndicatorVariant({
        variant: "chatgpt-dot",
        hostStyle: "claude",
        modelProvider: "anthropic",
      }),
    ).toBe("chatgpt-dot");
    expect(
      resolveLoadingIndicatorVariant({
        variant: "claude-mark",
        hostStyle: "chatgpt",
        modelProvider: "openai",
      }),
    ).toBe("claude-mark");
  });

  it("falls back to the model provider when no explicit or host style override exists", () => {
    expect(
      resolveLoadingIndicatorVariant({
        variant: undefined,
        modelProvider: "openai",
      }),
    ).toBe("chatgpt-dot");
    expect(
      resolveLoadingIndicatorVariant({
        variant: "default",
        modelProvider: "anthropic",
      }),
    ).toBe("claude-mark");
  });
});
