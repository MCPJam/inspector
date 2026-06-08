import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LoadingIndicatorContent,
  usesClaudeInlineStreamingFooter,
  usesMcpjamInlineStreamingFooter,
} from "../shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "@/lib/client-styles/indicators/claude-mark";
import { ChatboxHostStyleProvider } from "@/contexts/chatbox-client-style-context";

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

    render(
      <ChatboxHostStyleProvider value="claude">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

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

  it("renders the Claude mascot for Claude-style chatbox hosts", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
  });

  it("renders the GPT pulse for ChatGPT-style chatbox hosts", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
  });

  it("falls back to the model provider when no chatbox host context is set", () => {
    render(<LoadingIndicatorContent modelProvider="openai" />);
    expect(screen.getByTestId("loading-indicator-dot")).toBeInTheDocument();
  });

  it("maps anthropic provider to the Claude indicator", () => {
    render(<LoadingIndicatorContent modelProvider="anthropic" />);
    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
  });

  it("renders the generic Thinking… fallback when neither host nor provider resolves", () => {
    render(<LoadingIndicatorContent />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("renders the MCPJam dot indicator for MCPJam-style chatbox hosts", () => {
    render(
      <ChatboxHostStyleProvider value="mcpjam">
        <LoadingIndicatorContent />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("loading-indicator-mcpjam")).toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-claude"),
    ).not.toBeInTheDocument();
  });

  it("prefers the chatbox host context over the model provider", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <LoadingIndicatorContent modelProvider="openai" />
      </ChatboxHostStyleProvider>,
    );
    expect(screen.getByTestId("loading-indicator-claude")).toBeInTheDocument();
    expect(screen.queryByTestId("loading-indicator-dot")).not.toBeInTheDocument();
  });
});

describe("inline streaming footer host helpers", () => {
  it("treats Claude as a Claude-footer host but not MCPJam", () => {
    expect(usesClaudeInlineStreamingFooter("claude")).toBe(true);
    expect(usesClaudeInlineStreamingFooter("mcpjam")).toBe(false);
    expect(usesMcpjamInlineStreamingFooter("mcpjam")).toBe(true);
    expect(usesMcpjamInlineStreamingFooter("claude")).toBe(false);
  });
});
