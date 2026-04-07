import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import { FullscreenChatOverlay } from "../fullscreen-chat-overlay";

vi.mock("../shared/loading-indicator-content", () => ({
  LoadingIndicatorContent: ({ variant }: { variant?: string }) => (
    <div data-testid={`loading-indicator-${variant ?? "default"}`} />
  ),
}));

vi.mock("../shared/claude-loading-indicator", () => ({
  ClaudeLoadingIndicator: ({ mode = "animated" }: { mode?: string }) => (
    <div data-testid={`claude-indicator-${mode}`} />
  ),
}));

describe("FullscreenChatOverlay", () => {
  const createMessage = (overrides: Partial<UIMessage> = {}): UIMessage => ({
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
    ...overrides,
  });

  const defaultProps = {
    messages: [] as UIMessage[],
    open: true,
    onOpenChange: vi.fn(),
    input: "",
    onInputChange: vi.fn(),
    placeholder: "Message…",
    disabled: false,
    canSend: false,
    isThinking: false,
    onSend: vi.fn(),
  };

  it("shows a standalone Claude placeholder row before the first assistant token appears", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        isThinking={true}
        loadingIndicatorVariant="claude-mark"
      />,
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-mark"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("fullscreen-claude-footer-animated"),
    ).not.toBeInTheDocument();
  });

  it("moves the Claude mascot onto the latest assistant bubble while streaming", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[
          createMessage({ id: "msg-1", role: "user" }),
          createMessage({
            id: "msg-2",
            role: "assistant",
            parts: [{ type: "text", text: "Streaming..." }],
          }),
        ]}
        isThinking={true}
        loadingIndicatorVariant="claude-mark"
      />,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-animated"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-indicator-animated")).toBeInTheDocument();
  });

  it("keeps only one static Claude footer on the latest assistant bubble after loading", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[
          createMessage({
            id: "msg-1",
            role: "assistant",
            parts: [{ type: "text", text: "Older answer" }],
          }),
          createMessage({ id: "msg-2", role: "user" }),
          createMessage({
            id: "msg-3",
            role: "assistant",
            parts: [{ type: "text", text: "Latest answer" }],
          }),
        ]}
        isThinking={false}
        loadingIndicatorVariant="claude-mark"
      />,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-static"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId(/fullscreen-claude-footer-/)).toHaveLength(1);
    expect(screen.getByTestId("claude-indicator-static")).toBeInTheDocument();
  });
});
